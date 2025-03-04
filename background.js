console.log('Background script loaded.');

chrome.action.setBadgeText({ text: 'Diff' });

import DiffMatchPatch from "./diff_match_patch.js";

var originTabId; // Store the ID of the tab that initiated the license check
var dmp = new DiffMatchPatch();

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

// Helper function to send messages to a specific tab
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error(`Error sending message to tab ${tabId}:`, chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        console.log(`Message sent to tab ${tabId}:`, message.action);
        resolve(response);
      }
    });
  });
}

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

  console.log('Fetched licenses metadata:', licenses);

  const totalLicenses = licenses.length;
  let checkedLicenses = 0;

  // Fetch the text for each license and compare
  const matches = [];
  const batchSize = 20; // Process licenses in batches of 20

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
          if (score >= 50) { // Get results with at least 50% match
            var d = dmp.diff_main(text, licenseText); // diff array
            dmp.diff_cleanupSemantic(d); // diff semantic cleanup
            matches.push({
              license: license.license_key,
              name: licenseName,
              spdx: license.spdx_license_key,
              score: score.toFixed(2),
              diff: dmp.diff_prettyHtml(d)
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
    
    // Store the tab ID that initiated the request
    originTabId = sender.tab ? sender.tab.id : null;
    
    if (!originTabId) {
      // If no tab ID is available (e.g., sent from popup), get the current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
          console.error('Error getting active tab:', chrome.runtime.lastError);
          sendResponse({ error: 'Failed to identify origin tab' });
          return;
        }
        
        originTabId = tabs[0].id;
        processLicenseCheck(selectedText, sendResponse);
      });
    } else {
      // We have the sender tab ID
      processLicenseCheck(selectedText, sendResponse);
    }
    
    return true; // Required to use sendResponse asynchronously
  }
});

// New function to handle the license checking process
function processLicenseCheck(selectedText, sendResponse) {
  console.log('Processing license check for tab:', originTabId);
  
  // Show the UI in the originating tab
  sendMessageToTab(originTabId, { action: 'showUI' })
    .then(() => {
      // Function to send progress updates to the originating tab
      const sendProgress = (progress) => {
        sendMessageToTab(originTabId, { 
          action: 'progressUpdate', 
          progress 
        }).catch(err => console.error('Error sending progress update:', err));
      };
      
      // Fetch licenses and send results to the originating tab
      return fetchLicenses(selectedText, sendProgress);
    })
    .then(matches => {
      return sendMessageToTab(originTabId, { 
        action: 'showResults', 
        matches 
      });
    })
    .then(() => {
      sendResponse({ success: true });
    })
    .catch(error => {
      console.error('Error in license check process:', error);
      sendMessageToTab(originTabId, { 
        action: 'showError', 
        error: error.message 
      }).finally(() => {
        sendResponse({ error: error.message });
      });
    });
}

chrome.action.onClicked.addListener(tab => {
  chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: checkedLicenses
  });
});

chrome.runtime.onInstalled.addListener(connect);