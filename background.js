console.log('Background script loaded.');

chrome.action.setBadgeText({ text: 'Match' });


var tabId;

// Function to fetch data with IndexedDB caching
async function fetchWithCache(url, cacheKey, storeName) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(cacheKey);

    request.onsuccess = (event) => {
      if (event.target.result) {
        console.log(`Using cached data for ${cacheKey}`);
        resolve(event.target.result.data);
      } else {
        // Fetch from the network
        fetch(url)
          .then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
            }
            return response.json();
          })
          .then((data) => {
            // Cache the data
            const putTransaction = db.transaction([storeName], 'readwrite');
            const putStore = putTransaction.objectStore(storeName);
            const putRequest = putStore.put({ [storeName === 'metadata' ? 'id' : 'license_key']: cacheKey, data });

            putRequest.onsuccess = () => {
              console.log(`Cached data for ${cacheKey}`);
              resolve(data);
            };

            putRequest.onerror = (event) => {
              reject(`IndexedDB put error: ${event.target.errorCode}`);
            };
          })
          .catch((error) => {
            reject(error);
          });
      }
    };

    request.onerror = (event) => {
      reject(`IndexedDB get error: ${event.target.errorCode}`);
    };
  });
}

// Open or create an IndexedDB database
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('LicenseDB', 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('licenses')) {
        db.createObjectStore('licenses', { keyPath: 'license_key' });
      }
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(`IndexedDB error: ${event.target.errorCode}`);
    };
  });
}

// Function to calculate match score using cosine similarity
function calculateCosineSimilarity(text1, text2) {
  // Tokenize the texts into words
  const tokenize = (text) => text.toLowerCase().split(/\s+/);

  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  // Create a set of all unique tokens
  const allTokens = new Set([...tokens1, ...tokens2]);

  // Create vectors for each text
  const vector1 = Array.from(allTokens).map(token => tokens1.filter(t => t === token).length);
  const vector2 = Array.from(allTokens).map(token => tokens2.filter(t => t === token).length);

  // Calculate the dot product
  const dotProduct = vector1.reduce((sum, val, i) => sum + val * vector2[i], 0);

  // Calculate the magnitudes
  const magnitude1 = Math.sqrt(vector1.reduce((sum, val) => sum + val * val, 0));
  const magnitude2 = Math.sqrt(vector2.reduce((sum, val) => sum + val * val, 0));

  // Calculate the cosine similarity
  const similarity = dotProduct / (magnitude1 * magnitude2);

  // Return the similarity as a percentage
  return similarity * 100;
}

function generateDiff(text1, text2) {
  // Split the texts into lines
  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');

  let diff = '';

  // Compare line by line
  for (let lineIndex = 0; lineIndex < Math.max(lines1.length, lines2.length); lineIndex++) {
    const line1 = lines1[lineIndex] || '';
    const line2 = lines2[lineIndex] || '';

    // Split each line into words
    const words1 = line1.split(' ');
    const words2 = line2.split(' ');

    let lineDiff = '';
    let i = 0;
    let j = 0;

    // Compare word by word within the line
    while (i < words1.length || j < words2.length) {
      if (i < words1.length && j < words2.length && words1[i] === words2[j]) {
        // If the words are the same, add them to the lineDiff
        lineDiff += words1[i] + ' ';
        i++;
        j++;
      } else {
        // Start of a difference block
        let deleted = '';
        let inserted = '';

        // Collect deleted words (from text2)
        while (j < words2.length && (i >= words1.length || words1[i] !== words2[j])) {
          deleted += words2[j] + ' ';
          j++;
        }

        // Collect inserted words (from text1)
        while (i < words1.length && (j >= words2.length || words1[i] !== words2[j])) {
          inserted += words1[i] + ' ';
          i++;
        }

        // Add the deleted and inserted phrases to the lineDiff
        if (deleted) {
          lineDiff += `<span style="background:#ffe6e6;text-decoration:line-through">${deleted.trim()}</span> `;
        }
        if (inserted) {
          lineDiff += `<span style="background:#e6ffe6;text-decoration:underline">${inserted.trim()}</span> `;
        }
      }
    }

    // Add the lineDiff to the overall diff
    diff += lineDiff.trim() + '\n';
  }

  return diff.trim(); // Remove the trailing newline
}

/* // Function to generate a diff
function generateDiff(text1, text2) {
  let diff = '';
  for (let i = 0; i < Math.max(text1.length, text2.length); i++) {
    if (text1[i] === text2[i]) {
      diff += text1[i];
    } else {
      diff += `<span style="background:#ffe6e6;text-decoration:line-through">${text2[i] || ''}</span><span style="background:#e6ffe6;text-decoration:underline">${text1[i] || ''}</span>`;
    }
  }
  return diff;
} */

// Function to fetch licenses and compare text
async function fetchLicenses(text, sendProgress) {
  // Fetch the index.json file with caching
  const licenseList = await fetchWithCache(
    'https://scancode-licensedb.aboutcode.org/index.json',
    'index',
    'metadata'
  );

  const licenses = licenseList.filter(function( obj ) {
    return obj.is_deprecated !== true;
  });

/*   Object.entries(licenses).forEach(([key, value]) => {
    if (key === "is_deprecated" && value == true) {
        delete licenses[key]
    }
  }); */
  console.log('Fetched licenses metadata:', licenses);

  const totalLicenses = licenses.length;
  let checkedLicenses = 0;

  // Fetch the text for each license and compare
  const matches = [];
  const batchSize = 10; // Process licenses in batches of 10

  for (let i = 0; i < licenses.length; i += batchSize) {
    const batch = licenses.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (license) => {
        try {
          // Fetch the license text with caching
          const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
          const licenseData = await fetchWithCache(
            licenseUrl,
            license.license_key,
            'licenses'
          );

          const licenseText = licenseData.text;
          const licenseName = licenseData.name;

          if (!licenseText) {
            console.warn(`License ${license.license_key} is missing text. Skipping.`);
            return;
          }

          // Calculate the match score
          const score = calculateCosineSimilarity(text, licenseText);
          if (score >= 20) { // Show results with at least 20% match
            matches.push({
              license: license.license_key,
              name: licenseName,
              spdx: license.spdx_license_key,
              score: score.toFixed(2),
              diff: generateDiff(text, licenseText) // Include the diff
            });
          }

          // Update progress
          checkedLicenses++;
          if (checkedLicenses % batchSize === 0) {
            sendProgress({ checked: checkedLicenses, total: totalLicenses });
          }
        } catch (error) {
          console.error(`Error processing license ${license.license_key}:`, error);
        }
      })
    );
  }

  // Sort matches by score (highest first)
  matches.sort((a, b) => b.score - a.score);

    // Limit the number of matches to 10
    const topMatches = matches.slice(0, 10);

    return topMatches;
}

function checkedLicenses(){
  const selectedText = window.getSelection().toString();
  console.log('Selected text:', selectedText);

  if (selectedText) {
    chrome.runtime.sendMessage({ action: 'checkLicense', text: selectedText });
  } else {
    console.error('No text selected.');
  }
  sendResponse({ success: true });
}

function connect() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const port = chrome.tabs.connect(tabs[0].id);
    port.postMessage({ function: 'html' });
    port.onMessage.addListener((response) => {
      html = response.html;
      title = response.title;
      description = response.description;
    });
  });
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received in background script:', request);

  if (request.action === 'checkLicense') {
    const selectedText = request.text;

    // Show the UI
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.error('Error querying tabs:', chrome.runtime.lastError);
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }

      tabId = tabs[0].id;
      console.log('Sending message to tab:', tabId);

      chrome.tabs.sendMessage(tabId, { action: 'showUI' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Error sending message to content script:', chrome.runtime.lastError);
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        console.log('UI shown:', response);
        sendResponse({ success: true });
      });
    });

    // Function to send progress updates
    const sendProgress = (progress) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.error('Error querying tabs:', chrome.runtime.lastError);
          return;
        }

        tabId = tabs[0].id;
        console.log('Sending progress update to tab:', tabId);

        chrome.tabs.sendMessage(tabId, { action: 'progressUpdate', progress }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error sending progress update:', chrome.runtime.lastError);
            return;
          }
          console.log('Progress update sent:', response);
        });
      });
    };

    fetchLicenses(selectedText, sendProgress)
      .then(matches => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            console.error('Error querying tabs:', chrome.runtime.lastError);
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }

          tabId = tabs[0].id;
          console.log('Sending results to tab:', tabId);

          chrome.tabs.sendMessage(tabId, { action: 'showResults', matches }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('Error sending results:', chrome.runtime.lastError);
              sendResponse({ error: chrome.runtime.lastError.message });
              return;
            }
            console.log('Results sent:', response);
            sendResponse({ success: true });
          });
        });
      })
      .catch(error => {
        console.error('Error fetching licenses:', error);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            console.error('Error querying tabs:', chrome.runtime.lastError);
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }

          tabId = tabs[0].id;
          console.log('Sending error message to tab:', tabId);

          chrome.tabs.sendMessage(tabId, { action: 'showError', error: error.message }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('Error sending error message:', chrome.runtime.lastError);
              sendResponse({ error: chrome.runtime.lastError.message });
              return;
            }
            console.log('Error message sent:', response);
            sendResponse({ success: true });
          });
        });
      });

    return true; // Required to use sendResponse asynchronously
  }
});

chrome.action.onClicked.addListener(tab => {
  chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: checkedLicenses
  });
});

chrome.runtime.onInstalled.addListener(connect);