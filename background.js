console.log('Background script loaded.');

chrome.action.setBadgeText({ text: 'Diff' });

import DiffMatchPatch from "./diff_match_patch.js";

var originTabId; // Store the ID of the tab that initiated the license check
var dmp = new DiffMatchPatch();

// Track which tabs are currently running scans
const activeScans = new Set();

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

// Check if database is initialized
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

// Mark database as initialized
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
    let failures = 0;
    
    for (let i = 0; i < totalLicenses; i += batchSize) {
      const batch = licenses.slice(i, Math.min(i + batchSize, totalLicenses));
      
      // Process this batch
      await Promise.all(batch.map(async (license) => {
        try {
          // Fetch and store the license details
          const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
          const licenseData = await fetchWithCache(licenseUrl, license.license_key, 'licenses');
          
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
          failures++;
          console.error(`Error processing license ${license.license_key}:`, error);
        }
      }));
      
      // Update progress
      processed += batch.length;
      const percentComplete = Math.round((processed / totalLicenses) * 100);
      
      // Update badge to show progress
      chrome.action.setBadgeText({ text: `${percentComplete}%` });
      
      console.log(`License initialization progress: ${processed}/${totalLicenses} (${percentComplete}%)`);
    }
    
    // Mark database as initialized
    await markDatabaseInitialized();
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Diff' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });  // Green for success
    
    console.log(`License database initialization completed. Processed ${processed} licenses with ${failures} failures.`);
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
        resolve(event.target.result.data);
      } else {
        // Fetch from the network
        fetch(url)
          .then((response) => {
            if (!response.ok) {
              throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
            }
            
            // Check content type to verify it's JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
              console.warn(`Warning: ${url} returned non-JSON content type: ${contentType}`);
            }
            
            return response.text().then(text => {
              try {
                // Try to parse the text as JSON
                return JSON.parse(text);
              } catch (e) {
                console.error(`Error parsing JSON from ${url}:`, e);
                console.error(`Response starts with: ${text.substring(0, 100)}...`);
                throw new Error(`Invalid JSON response from ${url}`);
              }
            });
          })
          .then((data) => {
            // Cache the data
            const putTransaction = db.transaction([storeName], 'readwrite');
            const putStore = putTransaction.objectStore(storeName);
            const putRequest = putStore.put({ [storeName === 'metadata' ? 'id' : 'license_key']: cacheKey, data });

            putRequest.onsuccess = () => {
              resolve(data);
            };

            putRequest.onerror = (event) => {
              reject(`IndexedDB put error: ${event.target.errorCode}`);
            };
          })
          .catch((error) => {
            console.error(`Error fetching or processing ${url}:`, error);
            reject(error);
          });
      }
    };

    request.onerror = (event) => {
      reject(`IndexedDB get error: ${event.target.errorCode}`);
    };
  });
}

// Function to show a notification in the tab
function showNotification(tabId, message, type = 'info') {
  return sendMessageToTab(tabId, { 
    action: 'showNotification', 
    notification: {
      message,
      type // 'info', 'warning', 'error', 'success'
    }
  }).catch(err => console.error('Error sending notification:', err.message || err));
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          console.error(`Error sending message to tab ${tabId}:`, chrome.runtime.lastError.message || 'Unknown error');
          reject(new Error(chrome.runtime.lastError.message || 'Error communicating with tab'));
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      console.error(`Exception sending message to tab ${tabId}:`, error.message || error);
      reject(new Error(error.message || 'Unknown error sending message'));
    }
  });
}

// Create a term frequency map for the text
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

// Calculate Dice coefficient for text similarity
function calculateDiceCoefficient(vector1, vector2) {
  // Get the sets of terms
  const keys1 = new Set(Object.keys(vector1));
  const keys2 = new Set(Object.keys(vector2));
  
  // Calculate intersection size
  let intersectionSize = 0;
  for (const key of keys1) {
    if (keys2.has(key)) {
      intersectionSize++;
    }
  }
  
  // Calculate Dice coefficient: 2*|intersection| / (|set1| + |set2|)
  const diceCoefficient = (2 * intersectionSize) / (keys1.size + keys2.size);
  
  // Convert to percentage
  return diceCoefficient * 100;
}

// Quick similarity check for pre-filtering
function quickSimilarityCheck(textVector, licenseVector) {
  // Check if vectors share a minimum percentage of terms
  const textKeys = Object.keys(textVector);
  const licenseKeys = Object.keys(licenseVector);
  
  // Check length similarity first
  const lengthRatio = textKeys.length / licenseKeys.length;
  if (lengthRatio < 0.5 || lengthRatio > 2) {
    return false;
  }
  
  // Create sets for faster intersection calculation
  const textKeySet = new Set(textKeys);
  const licenseKeySet = new Set(licenseKeys);
  
  // Calculate a quick rough estimate of Dice coefficient
  let intersectionSize = 0;
  let minIntersectionNeeded = Math.min(textKeySet.size, licenseKeySet.size) * 0.2;
  
  for (const key of textKeySet) {
    if (licenseKeySet.has(key)) {
      intersectionSize++;
      if (intersectionSize >= minIntersectionNeeded) {
        return true;
      }
    }
  }
  
  return false;
}

// Function to fetch licenses and compare text
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
    
    // Maximum number of matches to show in dropdown
    const MAX_RESULTS = 10;
    
    // Create vector for the selected text
    const textVector = createTextVector(text);
    
    const totalLicenses = licenses.length;
    let checkedLicenses = 0;
    let promising = 0;
    
    // Send initial progress
    sendProgress({ checked: checkedLicenses, total: totalLicenses, promising });
    
    // Process licenses in batches for better performance
    const batchSize = 30;
    const potentialMatches = [];
    
    // Store vectors to avoid recalculating
    const licenseVectors = {};
    
    // PHASE 1: Score all licenses without generating diffs
    for (let i = 0; i < licenses.length; i += batchSize) {
      const batch = licenses.slice(i, i + batchSize);
      
      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (license) => {
          try {
            // Fetch the license text with caching
            const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
            let licenseData;
            
            try {
              licenseData = await fetchWithCache(
                licenseUrl,
                license.license_key,
                'licenses'
              );
            } catch (fetchError) {
              console.warn(`Skipping license ${license.license_key} due to fetch error:`, fetchError.message);
              return null;
            }

            const licenseText = licenseData.text;
            const licenseName = licenseData.name;

            if (!licenseText) {
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
            
            // Calculate the match score with Dice coefficient
            const score = calculateDiceCoefficient(textVector, licenseVector);
            
            if (score >= 15) { // Get results with at least 15% match using Dice
              return {
                license: license.license_key,
                name: licenseName,
                spdx: license.spdx_license_key,
                score: score.toFixed(2),
                licenseText: licenseText  // Store text for later diff generation
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
      potentialMatches.push(...validMatches);
      
      // Update progress
      checkedLicenses += batch.length;
      
      // Update progress
      sendProgress({ 
        checked: checkedLicenses, 
        total: totalLicenses,
        promising
      });
    }

    // Sort all matches by score (highest first)
    potentialMatches.sort((a, b) => b.score - a.score);

    // PHASE 2: Only generate diffs for the top matches
    const topMatches = potentialMatches.slice(0, MAX_RESULTS);
    
    // Generate diffs only for top matches
    sendProgress({ 
      checked: checkedLicenses, 
      total: totalLicenses,
      promising,
      message: "Generating diffs for top matches..."
    });
    
    // Process diffs in sequence to avoid high memory usage
    for (let i = 0; i < topMatches.length; i++) {
      const match = topMatches[i];
      // Generate diff using DiffMatchPatch
      var d = dmp.diff_main(text, match.licenseText);
      dmp.diff_cleanupEfficiency(d);
      match.diff = dmp.diff_prettyHtml(d);
      // Remove the license text to save memory
      delete match.licenseText;
    }
    
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

// Function to get selected text and send to background script
function checkedLicenses() {
  try {
    const selectedText = window.getSelection().toString();

    if (selectedText) {
      chrome.runtime.sendMessage({ action: 'checkLicense', text: selectedText });
    } else {
      console.error('No text selected.');
      // Show a notification about no text selected
      chrome.runtime.sendMessage({ action: 'noTextSelected' });
    }
  } catch (error) {
    console.error('Error in checkedLicenses:', error);
  }
}

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
          console.error('Error getting active tab:', chrome.runtime.lastError ? 
                        chrome.runtime.lastError.message : 'No active tabs found');
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
  } else if (request.action === 'noTextSelected') {
    // Handle no text selected
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        showNotification(tabs[0].id, "Please select text before running license check.", "warning");
      }
    });
    sendResponse({ status: 'received' });
    return false;
  }
  
  // Default response for other messages
  sendResponse({ status: 'received' });
  return false;
});

// Function to handle the license checking process
function processLicenseCheck(selectedText) {
  // Check if scan already running for this tab
  if (activeScans.has(originTabId)) {
    console.log(`Scan already in progress for tab ${originTabId}`);
    showNotification(originTabId, "A license check is already in progress on this tab. Please wait.", "warning");
    return;
  }

  // Mark this tab as having an active scan
  activeScans.add(originTabId);
  
  // First clear any previous results
  sendMessageToTab(originTabId, { action: 'clearResults' })
    .then(() => {
      // Show the UI in the originating tab
      return sendMessageToTab(originTabId, { action: 'showUI' });
    })
    .then(() => {
      // Function to send progress updates to the originating tab
      const sendProgress = (progress) => {
        sendMessageToTab(originTabId, { 
          action: 'progressUpdate', 
          progress 
        }).catch(err => console.error('Error sending progress update:', err.message || err));
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
      // More detailed error handling
      const errorMessage = error.message || (typeof error === 'string' ? error : 'Unknown error');
      console.error('Error in license check process:', errorMessage);
      
      // Check if tab still exists before trying to send the error
      chrome.tabs.get(originTabId, (tab) => {
        if (chrome.runtime.lastError) {
          console.error('Cannot send error to tab - tab may be closed:', chrome.runtime.lastError.message);
          return;
        }
        
        sendMessageToTab(originTabId, { 
          action: 'showError', 
          error: errorMessage 
        }).catch(err => {
          console.error('Failed to send error to tab:', err.message || err);
        });
      });
    })
    .finally(() => {
      // Remove the tab from active scans when finished (success or failure)
      activeScans.delete(originTabId);
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
      showNotification(tab.id, "Error executing script: " + (err.message || "Unknown error"), "error");
    });
  } catch (err) {
    console.error('Error handling action click:', err);
  }
});

// Extension installation handler
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`Extension ${details.reason}ed.`);
  
  // On fresh install or update, preload the database
  if (details.reason === 'install' || details.reason === 'update') {
    await preloadLicenseDatabase();
  }
});