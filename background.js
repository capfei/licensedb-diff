console.log('Background script loaded.');

chrome.action.setBadgeText({ text: 'Diff' });

// Initialize DiffMatchPatch without using dynamic imports
let dmp;

// Create an initialization function that doesn't use import()
function initializeDependencies() {
  try {
    // Create our own minimal implementation of DiffMatchPatch for the background script
    // This avoids the need to import the full library
    dmp = {
      diff_main: function(text1, text2) {
        // We'll only use this for checking if there's a difference, not for display
        return text1 === text2 ? [] : [[-1, text1], [1, text2]];
      },
      diff_cleanupSemantic: function() {
        // No-op in this simplified version
      },
      diff_prettyHtml: function(diff) {
        // Simple HTML representation - actual diff display will happen in content script
        return `<div>Detailed diff will be generated in the UI</div>`;
      }
    };
    
    console.log('Using simplified DiffMatchPatch implementation in background script');
    return true;
  } catch (error) {
    console.error('Error initializing dependencies:', error);
    return false;
  }
}

var originTabId; // Store the ID of the tab that initiated the license check

// Run initialization when the script loads
initializeDependencies();

// Database version - increment when structure changes
const DB_VERSION = 2;

// Open or create an IndexedDB database with updated version
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('LicenseDB', DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('licenses')) {
        db.createObjectStore('licenses', { keyPath: 'license_key' });
      }
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'license_key' });
      }
      // Add a new store to track initialization status
      if (!db.objectStoreNames.contains('status')) {
        db.createObjectStore('status', { keyPath: 'id' });
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

// New function to check if database is initialized
async function isDatabaseInitialized() {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(['status'], 'readonly');
      const store = transaction.objectStore('status');
      const request = store.get('initialization');
      
      request.onsuccess = (event) => {
        const result = event.target.result;
        resolve(result && result.completed === true);
      };
      
      request.onerror = () => {
        resolve(false);
      };
    });
  } catch (error) {
    console.error('Error checking database initialization:', error);
    return false;
  }
}

// New function to mark database as initialized
async function markDatabaseInitialized() {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['status'], 'readwrite');
      const store = transaction.objectStore('status');
      const request = store.put({ 
        id: 'initialization', 
        completed: true,
        timestamp: new Date().toISOString() 
      });
      
      request.onsuccess = () => resolve(true);
      request.onerror = (error) => reject(error);
    });
  } catch (error) {
    console.error('Error marking database as initialized:', error);
    return false;
  }
}

// Function to preload all license data
async function preloadLicenseDatabase() {
  try {
    // Check if already initialized
    const isInitialized = await isDatabaseInitialized();
    if (isInitialized) {
      console.log('License database already initialized');
      return true;
    }
    
    console.log('Starting license database initialization...');
    chrome.action.setBadgeText({ text: 'Load' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });  // Orange for loading
    
    // First, fetch the license index
    const licenseList = await fetch('https://scancode-licensedb.aboutcode.org/index.json')
      .then(response => response.json());
      
    // Filter out deprecated licenses
    const licenses = licenseList.filter(obj => !obj.is_deprecated);
    console.log(`Found ${licenses.length} non-deprecated licenses`);
    
    // Store the index
    const db = await openDatabase();
    const metadataStore = db.transaction(['metadata'], 'readwrite')
      .objectStore('metadata');
    await new Promise((resolve, reject) => {
      const request = metadataStore.put({ id: 'index', data: licenses });
      request.onsuccess = () => resolve();
      request.onerror = (error) => reject(error);
    });
    
    // Process licenses in batches
    const batchSize = 50;
    const totalLicenses = licenses.length;
    let processed = 0;
    
    for (let i = 0; i < totalLicenses; i += batchSize) {
      const batch = licenses.slice(i, Math.min(i + batchSize, totalLicenses));
      
      // Process this batch
      await Promise.all(batch.map(async (license) => {
        try {
          // Fetch and store the license details
          const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
          const licenseData = await fetch(licenseUrl).then(response => response.json());
          
          // Store in licenses store
          const licenseStore = db.transaction(['licenses'], 'readwrite')
            .objectStore('licenses');
          await new Promise((resolve, reject) => {
            const request = licenseStore.put({ license_key: license.license_key, data: licenseData });
            request.onsuccess = () => resolve();
            request.onerror = (error) => reject(error);
          });
          
          // Pre-calculate and store the license text vector
          if (licenseData.text) {
            const vector = createTextVector(licenseData.text);
            const vectorStore = db.transaction(['vectors'], 'readwrite')
              .objectStore('vectors');
            await new Promise((resolve, reject) => {
              const request = vectorStore.put({ license_key: license.license_key, data: vector });
              request.onsuccess = () => resolve();
              request.onerror = (error) => reject(error);
            });
          }
        } catch (error) {
          console.error(`Error processing license ${license.license_key}:`, error);
        }
      }));
      
      // Update progress
      processed += batch.length;
      const percentComplete = Math.round((processed / totalLicenses) * 100);
      
      // Update badge to show progress
      chrome.action.setBadgeText({ text: `Initializing: ${percentComplete}%` });
      
      console.log(`License initialization progress: ${processed}/${totalLicenses} (${percentComplete}%)`);
    }
    
    // Mark database as initialized
    await markDatabaseInitialized();
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Diff' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });  // Green for success
    
    console.log('License database initialization completed successfully');
    return true;
  } catch (error) {
    console.error('Error initializing license database:', error);
    chrome.action.setBadgeText({ text: 'Err' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });  // Red for error
    return false;
  }
}

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

// Helper function to send messages to a specific tab with better error handling
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          console.error(`Error sending message to tab ${tabId}:`, chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          console.log(`Message sent to tab ${tabId}:`, message.action, response);
          resolve(response);
        }
      });
    } catch (error) {
      console.error(`Exception sending message to tab ${tabId}:`, error);
      reject(error);
    }
  });
}

// Create a term frequency map for the text (moved from worker)
function createTextVector(text) {
  // Normalize text: lowercase, remove punctuation, split into words
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(word => word.length > 0);
  
  // Create term frequency map
  const vector = {};
  for (const word of words) {
    vector[word] = (vector[word] || 0) + 1;
  }
  
  return vector;
}

// Calculate cosine similarity between two vectors (moved from worker)
function calculateCosineSimilarity(vector1, vector2) {
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;
  
  // Calculate dot product and magnitudes
  const allKeys = new Set([...Object.keys(vector1), ...Object.keys(vector2)]);
  
  for (const key of allKeys) {
    const val1 = vector1[key] || 0;
    const val2 = vector2[key] || 0;
    
    dotProduct += val1 * val2;
    magnitude1 += val1 * val1;
    magnitude2 += val2 * val2;
  }
  
  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);
  
  // Prevent division by zero
  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }
  
  // Calculate the similarity
  return (dotProduct / (magnitude1 * magnitude2)) * 100;
}

// Quick similarity check for pre-filtering (moved from worker)
function quickSimilarityCheck(textVector, licenseVector) {
  // Check if vectors share a minimum percentage of terms
  const textKeys = Object.keys(textVector);
  const licenseKeys = Object.keys(licenseVector);
  
  // Check length similarity first
  const lengthRatio = textKeys.length / licenseKeys.length;
  if (lengthRatio < 0.5 || lengthRatio > 2) {
    return false;
  }
  
  // Check common terms
  let common = 0;
  const minRequired = Math.min(textKeys.length, licenseKeys.length) * 0.3; // 30% overlap minimum
  
  for (const key of textKeys) {
    if (licenseVector[key]) {
      common++;
      if (common >= minRequired) {
        return true;
      }
    }
  }
  
  return false;
}

// Function to fetch licenses and compare text - updated to avoid DiffMatchPatch issues
async function fetchLicenses(text, sendProgress) {
  // Check if database is initialized
  const isInitialized = await isDatabaseInitialized();
  if (!isInitialized) {
    // If not initialized, do it now
    sendProgress({ 
      checked: 0, 
      total: 1, 
      promising: 0,
      message: 'Initializing license database...' 
    });
    
    await preloadLicenseDatabase();
  }
  
  try {
    // Fetch the index.json file with caching
    const licenseList = await fetchWithCache(
      'https://scancode-licensedb.aboutcode.org/index.json',
      'index',
      'metadata'
    );

    // Filter out deprecated licenses
    const licenses = licenseList.filter(obj => !obj.is_deprecated);
    console.log('Fetched licenses metadata:', licenses.length);
    
    // Create vector for the selected text
    const textVector = createTextVector(text);
    
    const totalLicenses = licenses.length;
    let checkedLicenses = 0;
    let promising = 0;
    
    // Send initial progress
    sendProgress({ checked: checkedLicenses, total: totalLicenses, promising });
    
    // Process licenses in batches for better performance
    const batchSize = 30;
    const allMatches = [];
    
    // Store vectors to avoid recalculating
    const licenseVectors = {};
    
    for (let i = 0; i < licenses.length; i += batchSize) {
      const batch = licenses.slice(i, i + batchSize);
      
      // Process batch in parallel
      const batchResults = await Promise.all(
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
              return null;
            }
            
            // Create vector for the license text
            const licenseVector = licenseVectors[license.license_key] || createTextVector(licenseText);
            licenseVectors[license.license_key] = licenseVector;
            
            // Quick pre-filtering check
            if (!quickSimilarityCheck(textVector, licenseVector)) {
              return null;
            }
            
            // Candidate is promising - do more detailed comparison
            promising++;
            
            // Calculate the match score with full cosine similarity
            const score = calculateCosineSimilarity(textVector, licenseVector);
            
            if (score >= 50) { // Get results with at least 50% match
              // Don't generate the diff in the background script
              // Just prepare the necessary data for the content script
              return {
                license: license.license_key,
                name: licenseName,
                spdx: license.spdx_license_key,
                score: score.toFixed(2),
                // Send the full text so content script can generate the diff
                licenseText: licenseText
              };
            }
            
            return null;
          } catch (error) {
            console.error(`Error processing license ${license.license_key}:`, error);
            return null;
          }
        })
      );
      
      // Filter out nulls and add matches
      const validMatches = batchResults.filter(Boolean);
      allMatches.push(...validMatches);
      
      // Update progress
      checkedLicenses += batch.length;
      
      // Update progress WITHOUT partial results
      sendProgress({ 
        checked: checkedLicenses, 
        total: totalLicenses,
        promising
      });
    }

    // Sort all matches by score (highest first)
    allMatches.sort((a, b) => b.score - a.score);

    // Limit the number of matches to 10
    const topMatches = allMatches.slice(0, 10);
    
    // Add link property to each match
    topMatches.forEach(match => {
      match.link = `<a href="https://scancode-licensedb.aboutcode.org/${match.license}.html" target="_blank">${match.name}</a> (${match.spdx})`;
    });

    return topMatches;
  } catch (error) {
    console.error("Error in fetchLicenses:", error);
    throw error;
  }
}

// Fix for checkedLicenses function
function checkedLicenses() {
  try {
    const selectedText = window.getSelection().toString();
    console.log('Selected text:', selectedText);

    if (selectedText) {
      chrome.runtime.sendMessage({ action: 'checkLicense', text: selectedText });
    } else {
      console.error('No text selected.');
    }
  } catch (error) {
    console.error('Error in checkedLicenses:', error);
  }
  // No sendResponse here since it's injected
}

// Improved connect function with error handling
function connect() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
        console.warn('No active tab found for connection');
        resolve(false);
        return;
      }

      // Check if we can inject content scripts in this tab
      const tab = tabs[0];
      const url = tab.url || '';
      
      // Skip chrome:// pages, extension pages, etc.
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || 
          url.startsWith('about:') || url.startsWith('edge://')) {
        console.log(`Skipping connection to restricted page: ${url}`);
        resolve(false);
        return;
      }
      
      try {
        const port = chrome.tabs.connect(tab.id, { name: 'license-matcher' });
        
        port.onDisconnect.addListener(() => {
          if (chrome.runtime.lastError) {
            console.warn('Port disconnected due to error:', chrome.runtime.lastError.message);
          }
          resolve(false);
        });
        
        port.postMessage({ function: 'html' });
        
        port.onMessage.addListener((response) => {
          // Only store if we actually got valid data
          if (response && response.html) {
            console.log('Successfully connected to tab and received HTML');
            // Store data safely
            try {
              window.cachedHtml = response.html;
              window.cachedTitle = response.title;
              window.cachedDescription = response.description;
            } catch (err) {
              console.error('Error storing tab data:', err);
            }
          }
          resolve(true);
        });
      } catch (err) {
        console.warn('Error establishing connection:', err);
        resolve(false);
      }
    });
  });
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received in background script:', request);

  if (request.action === 'checkLicense') {
    const selectedText = request.text;
    
    // Send an immediate response to keep the message port alive
    sendResponse({ status: 'processing' });
    
    // Store the tab ID that initiated the request
    originTabId = sender.tab ? sender.tab.id : null;
    
    if (!originTabId) {
      // If no tab ID is available (e.g., sent from popup), get the current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
          console.error('Error getting active tab:', chrome.runtime.lastError);
          return;
        }
        
        originTabId = tabs[0].id;
        processLicenseCheck(selectedText);
      });
    } else {
      // We have the sender tab ID
      processLicenseCheck(selectedText);
    }
    
    return false; // Don't need to keep port open for asynchronous response
  }
  
  // Default response for other messages
  sendResponse({ status: 'received' });
  return false;
});

// Function to handle the license checking process - modified to not use sendResponse
function processLicenseCheck(selectedText) {
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
    .catch(error => {
      console.error('Error in license check process:', error);
      sendMessageToTab(originTabId, { 
        action: 'showError', 
        error: error.message 
      });
    });
}

// Update the action click handler to ensure connection before execution
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Make sure we're on a supported page
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || 
        url.startsWith('about:') || url.startsWith('edge://')) {
      console.warn('Cannot run on this page type:', url);
      return;
    }
    
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: checkedLicenses
    }).catch(err => {
      console.error('Script execution error:', err);
    });
  } catch (err) {
    console.error('Error handling action click:', err);
  }
});

// Modified onInstalled handler to avoid immediate connection attempts
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`Extension ${details.reason}ed.`);
  
  // On fresh install or update, preload the database but don't try to connect yet
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('Starting database preload...');
    await preloadLicenseDatabase();
  }
  
  // No immediate connect() call here - we'll connect when needed
});

// Add a helper function to handle connection only when needed
async function ensureConnection() {
  // Only try to connect if we're going to use the connection
  const connected = await connect();
  console.log('Connection established:', connected);
  return connected;
}