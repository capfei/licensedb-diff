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
    
    // Record the update timestamp when initializing
    await recordUpdateTimestamp();
    
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
          const msg = chrome.runtime.lastError.message || 'Unknown error';
          // Attempt one-time dynamic injection if content script missing
          if (msg.includes('Could not establish connection. Receiving end does not exist')) {
            console.warn('Content script not found in tab ' + tabId + ', attempting dynamic injection...');
            // Try injecting JS and CSS then resend once
            Promise.all([
              chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(()=>{}),
              chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
            ]).then(() => {
              chrome.tabs.sendMessage(tabId, message, (secondResp) => {
                if (chrome.runtime.lastError) {
                  console.error('Retry after injection failed:', chrome.runtime.lastError.message);
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(secondResp);
                }
              });
            }).catch(injectErr => {
              console.error('Dynamic injection failed:', injectErr);
              reject(new Error(msg));
            });
          } else {
            console.error(`Error sending message to tab ${tabId}:`, msg);
            reject(new Error(msg));
          }
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

// Ensure content script is present in tab before messaging heavy workflow
async function ensureContentScript(tabId) {
  try {
    await sendMessageToTab(tabId, { action: 'ping' }); // cheap test
    return true; // already there
  } catch (e) {
    // Attempt injection
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(()=>{});
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      // Small delay to allow script init
      await new Promise(r => setTimeout(r, 50));
      return true;
    } catch (injErr) {
      console.error('ensureContentScript failed injection:', injErr);
      return false;
    }
  }
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
      var d = dmp.diff_main(match.licenseText, text);
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

// Process a license check request
async function processLicenseCheck(selectedText) {
  if (!selectedText || selectedText.trim().length === 0) {
    showNotification(originTabId, 'Please select some text to compare with licenses.', 'warning');
    return;
  }
  
  if (activeScans.has(originTabId)) {
    showNotification(originTabId, 'Already processing a license check. Please wait...', 'info');
    return;
  }
  
  // Mark this tab as having an active scan
  activeScans.add(originTabId);
  
  try {
    // Make sure content script is available
    const ready = await ensureContentScript(originTabId);
    if (!ready) {
      console.error('Content script not available after injection attempts.');
      return;
    }
    // Show UI and clear previous results with retry
    for (const m of ['showUI','clearResults']) {
      try {
        await sendMessageToTab(originTabId, { action: m });
      } catch (msgErr) {
        console.warn('Retrying message', m, 'after brief delay due to', msgErr.message);
        await new Promise(r=>setTimeout(r,100));
        await sendMessageToTab(originTabId, { action: m });
      }
    }
    
    // Progress callback for reporting scan progress
    const sendProgress = async (progress) => {
      try {
        await sendMessageToTab(originTabId, { 
          action: 'progressUpdate', 
          progress 
        });
      } catch (error) {
        console.error('Error sending progress update:', error);
      }
    };
    
    // Fetch and compare licenses
    const matches = await fetchLicenses(selectedText, sendProgress);
    
    if (matches && matches.length > 0) {
      // Report the matches to the content script
      await sendMessageToTab(originTabId, { 
        action: 'showResults', 
        matches 
      });
    } else {
      await sendMessageToTab(originTabId, { 
        action: 'showError', 
        error: 'No significant license matches found.' 
      });
    }
  } catch (error) {
    console.error('Error processing license check:', error);
    try {
      await sendMessageToTab(originTabId, { 
        action: 'showError', 
        error: error.message || 'An unknown error occurred' 
      });
    } catch (err) {
      console.error('Error showing error notification:', err);
    }
  } finally {
    // Remove this tab from active scans
    activeScans.delete(originTabId);
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkLicense') {
    const selectedText = message.text;
    
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
  } else if (message.action === 'noTextSelected') {
    // Handle no text selected
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0) {
        showNotification(tabs[0].id, "Please select text before running license check.", "warning");
      }
    });
    sendResponse({ status: 'received' });
    return false;
  } else if (message.action === 'getDatabaseInfo') {
    // Handle request for database information
    getDatabaseInfo()
      .then(info => sendResponse(info))
      .catch(error => sendResponse({ error: error.message || 'Unknown error' }));
    return true; // Keep port open for async response
  } else if (message.action === 'refreshDatabase') {
    // Handle manual database refresh
    forceUpdateDatabase()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message || 'Unknown error' }));
    return true; // Keep port open for async response
  } else if (message.action === 'resetDatabase') {
    // Handle database reset
    resetDatabase()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message || 'Unknown error' }));
    return true; // Keep port open for async response
  }
  
  // Default response for other messages
  sendResponse({ status: 'received' });
  return false;
});

// Get database information for the options page
async function getDatabaseInfo() {
  try {
    const db = await openDatabase();
    
    // Get initialization status
    const isInitialized = await isDatabaseInitialized();
    
    // Get last update timestamp
    let lastUpdate = null;
    try {
      const transaction = db.transaction(['status'], 'readonly');
      const store = transaction.objectStore('status');
      const request = store.get('last_update');
      lastUpdate = await new Promise((resolve) => {
        request.onsuccess = (event) => {
          const result = event.target.result;
          resolve(result && result.timestamp ? result.timestamp : null);
        };
        request.onerror = () => resolve(null);
      });
    } catch (error) {
      console.error('Error getting last update:', error);
    }
    
    // Get license count
    let licenseCount = 0;
    try {
      const transaction = db.transaction(['licenses'], 'readonly');
      const store = transaction.objectStore('licenses');
      const countRequest = store.count();
      licenseCount = await new Promise((resolve) => {
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => resolve(0);
      });
    } catch (error) {
      console.error('Error getting license count:', error);
    }
    
    // Get LicenseDB version from GitHub API
    let licenseDbVersion = await getLicenseDbVersionFromGitHub();
    
    return {
      isInitialized,
      lastUpdate,
      licenseCount,
      licenseDbVersion
    };
  } catch (error) {
    console.error('Error getting database info:', error);
    throw error;
  }
}

// Function to get LicenseDB version from GitHub API
async function getLicenseDbVersionFromGitHub() {
  try {
    // Check if we have a cached version in storage
    const cachedVersion = await getCachedLicenseDbVersion();
    
    // If we have a cached version that's less than 1 day old, use it
    if (cachedVersion && cachedVersion.timestamp) {
      const cacheTime = new Date(cachedVersion.timestamp).getTime();
      const now = new Date().getTime();
      const oneDayInMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      
      if (now - cacheTime < oneDayInMs) {
        console.log('Using cached LicenseDB version');
        return cachedVersion.version;
      }
    }
    
    // Fetch the latest version from GitHub API
    console.log('Fetching LicenseDB version from GitHub API');
    const response = await fetch('https://api.github.com/repos/aboutcode-org/scancode-toolkit/releases/latest');
    
    if (!response.ok) {
      throw new Error(`Failed to fetch from GitHub API: ${response.statusText}`);
    }
    
    const data = await response.json();
    const version = data.name || data.tag_name || 'Unknown';
    
    // Cache the version for future use
    await cacheLicenseDbVersion(version);
    
    return version;
  } catch (error) {
    console.error('Error fetching LicenseDB version from GitHub:', error);
    
    // If we have a cached version, return it even if it's old
    const cachedVersion = await getCachedLicenseDbVersion();
    if (cachedVersion && cachedVersion.version) {
      return `${cachedVersion.version} (cached)`;
    }
    
    return 'Error fetching version';
  }
}

// Cache the LicenseDB version
async function cacheLicenseDbVersion(version) {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['status'], 'readwrite');
      const store = transaction.objectStore('status');
      const request = store.put({
        id: 'licensedb_version',
        version: version,
        timestamp: new Date().toISOString()
      });
      
      request.onsuccess = () => resolve(true);
      request.onerror = (error) => reject(error);
    });
  } catch (error) {
    console.error('Error caching LicenseDB version:', error);
    return false;
  }
}

// Get the cached LicenseDB version
async function getCachedLicenseDbVersion() {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(['status'], 'readonly');
      const store = transaction.objectStore('status');
      const request = store.get('licensedb_version');
      
      request.onsuccess = (event) => {
        const result = event.target.result;
        resolve(result || null);
      };
      
      request.onerror = () => resolve(null);
    });
  } catch (error) {
    console.error('Error getting cached LicenseDB version:', error);
    return null;
  }
}

// Force update the database (manual trigger from options page)
async function forceUpdateDatabase() {
  try {
    // Set badge to indicate update in progress
    chrome.action.setBadgeText({ text: 'Updt' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' }); // Orange
    
    // Send initial progress to options page
    sendProgressUpdate(0, 'Starting database update...');
    
    // Fetch the license index to check for changes
    sendProgressUpdate(5, 'Fetching license index...');
    const response = await fetch('https://scancode-licensedb.aboutcode.org/index.json', {
      cache: 'no-cache' // Force fresh content
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch license index: ${response.statusText}`);
    }
    
    const licenseList = await response.json();
    
    // Filter out deprecated licenses
    const licenses = licenseList.filter(obj => !obj.is_deprecated);
    
    sendProgressUpdate(10, `Found ${licenses.length} non-deprecated licenses`);
    
    // Store the updated index
    const db = await openDatabase();
    const metadataStore = db.transaction(['metadata'], 'readwrite').objectStore('metadata');
    await new Promise((resolve, reject) => {
      const request = metadataStore.put({ id: 'index', data: licenses });
      request.onsuccess = () => resolve();
      request.onerror = (error) => reject(error);
    });
    
    // Process licenses in batches (similar to checkForDatabaseUpdates but with progress updates)
    const batchSize = 50;
    const totalLicenses = licenses.length;
    let processed = 0;
    let failures = 0;
    
    for (let i = 0; i < totalLicenses; i += batchSize) {
      const batch = licenses.slice(i, Math.min(i + batchSize, totalLicenses));
      
      // Process this batch
      await Promise.all(batch.map(async (license) => {
        try {
          // Fetch with no-cache to get fresh content
          const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
          const response = await fetch(licenseUrl, { cache: 'no-cache' });
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${licenseUrl}: ${response.statusText}`);
          }
          
          const licenseData = await response.json();
          
          // Store in licenses store
          const licenseStore = db.transaction(['licenses'], 'readwrite').objectStore('licenses');
          await new Promise((resolve, reject) => {
            const request = licenseStore.put({ license_key: license.license_key, data: licenseData });
            request.onsuccess = () => resolve();
            request.onerror = (error) => reject(error);
          });
          
          // Pre-calculate and store the license text vector
          if (licenseData.text) {
            const vector = createTextVector(licenseData.text);
            const vectorStore = db.transaction(['vectors'], 'readwrite').objectStore('vectors');
            await new Promise((resolve, reject) => {
              const request = vectorStore.put({ license_key: license.license_key, data: vector });
              request.onsuccess = () => resolve();
              request.onerror = (error) => reject(error);
            });
          }
        } catch (error) {
          failures++;
          console.error(`Error processing license ${license.license_key} during update:`, error);
        }
      }));
      
      // Update progress
      processed += batch.length;
      const percentComplete = Math.round((10 + (processed / totalLicenses) * 85)); // Scale to 10-95%
      
      // Send progress update
      sendProgressUpdate(
        percentComplete,
        `Processing licenses: ${processed}/${totalLicenses} (${failures} failures)`
      );
      
      // Update badge to show progress
      chrome.action.setBadgeText({ text: `${Math.round(percentComplete)}%` });
    }
    
    // Record the update timestamp
    sendProgressUpdate(95, 'Finalizing update...');
    await recordUpdateTimestamp();
    
    // Set flag to indicate database is initialized
    await markDatabaseInitialized();
    
    // Also update the licensedb version when forcing an update
    await getLicenseDbVersionFromGitHub();
    
    // Final success
    sendProgressUpdate(100, 'Database update complete', true);
    
    console.log(`License database update completed. Processed ${processed} licenses with ${failures} failures.`);
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Diff' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });  // Green
    
    return true;
  } catch (error) {
    console.error('Error updating database:', error);
    
    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Err' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });  // Red
    
    setTimeout(() => {
      chrome.action.setBadgeText({ text: 'Diff' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }, 5000);
    
    throw error;
  }
}

// Reset database (completely delete and reinitialize)
async function resetDatabase() {
  try {
    // Set badge to indicate reset in progress
    chrome.action.setBadgeText({ text: 'Rst' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' }); // Orange
    
    // Send initial progress to options page
    sendProgressUpdate(0, 'Deleting database...');
    
    // Delete the database
    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase('LicenseDB');
      deleteRequest.onsuccess = () => {
        console.log('Database deleted successfully');
        resolve();
      };
      deleteRequest.onerror = () => {
        const error = new Error('Failed to delete database');
        console.error(error);
        reject(error);
      };
    });
    
    sendProgressUpdate(20, 'Database deleted. Initializing new database...');
    
    // Reinitialize database
    await preloadLicenseDatabase();
    
    // Final update
    sendProgressUpdate(100, 'Database reset and reinitialized successfully', true);
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Diff' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });  // Green
    
    return true;
  } catch (error) {
    console.error('Error resetting database:', error);
    
    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);
    
    // Reset badge
    chrome.action.setBadgeText({ text: 'Err' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });  // Red
    
    setTimeout(() => {
      chrome.action.setBadgeText({ text: 'Diff' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }, 5000);
    
    throw error;
  }
}

// Function to send progress updates to the options page
function sendProgressUpdate(progress, message, complete = false) {
  chrome.runtime.sendMessage({
    action: 'updateProgress',
    progress: progress,
    message: message,
    complete: complete
  }).catch(error => {
    console.log('Could not send progress update (options page may be closed)', error);
  });
}

// Update the action click handler to ensure connection before execution
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
        url.startsWith('about:') || url.startsWith('edge://')) {
      console.warn('Cannot run on this page type:', url);
      return;
    }

    // Collect selection info from all accessible frames (longest selection wins)
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        try {
          const sel = window.getSelection();
          if (sel && sel.toString().trim()) {
            return {
              text: sel.toString(),
              inIframe: window.top !== window,
              frameUrl: location.href
            };
          }
        } catch (e) {
          // ignore frame errors
        }
        return null;
      }
    }).then(results => {
      if (!results || !Array.isArray(results)) {
        showNotification(tab.id, 'No selection found.', 'warning');
        return;
      }
      // Pick longest non-null selection
      const candidates = results.map(r => r.result).filter(r => r && r.text && r.text.trim());
      if (candidates.length === 0) {
        showNotification(tab.id, 'Please select text before running license check.', 'warning');
        return;
      }
      const best = candidates.reduce((a, b) => (b.text.length > a.text.length ? b : a));

      // Send single message to existing handler (adds iframe metadata for future use)
  // Directly initiate processing instead of round-trip messaging
      originTabId = tab.id;
      // Ensure content script/UI is present before processing (attempt a lightweight showUI message)
      sendMessageToTab(tab.id, { action: 'showUI' })
        .catch(() => Promise.resolve()) // ignore; injection fallback happens in sendMessageToTab
        .finally(() => {
          processLicenseCheck(best.text);
        });
    }).catch(err => {
      console.error('Selection collection error:', err);
      showNotification(tab.id, 'Error gathering selection: ' + (err.message || 'Unknown error'), 'error');
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
    // Setup periodic updates
    setupPeriodicUpdates();
  }
});

// Also setup updates on browser startup
chrome.runtime.onStartup.addListener(() => {
  setupPeriodicUpdates();
});

// Check if database update is needed (every two weeks)
async function isUpdateNeeded() {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(['status'], 'readonly');
      const store = transaction.objectStore('status');
      const request = store.get('last_update');
      
      request.onsuccess = (event) => {
        const result = event.target.result;
        
        if (!result || !result.timestamp) {
          // No timestamp found, update needed
          resolve(true);
          return;
        }
        
        const lastUpdateTime = new Date(result.timestamp).getTime();
        const currentTime = new Date().getTime();
        const twoWeeksInMs = 14 * 24 * 60 * 60 * 1000; // 14 days in milliseconds
        
        // Check if two weeks have passed since last update
        resolve(currentTime - lastUpdateTime > twoWeeksInMs);
      };
      
      request.onerror = () => {
        console.error('Error checking last update timestamp');
        // If there's an error, assume update is needed
        resolve(true);
      };
    });
  } catch (error) {
    console.error('Error checking if update is needed:', error);
    return true; // On error, assume update is needed
  }
}

// Record the timestamp of the current update
async function recordUpdateTimestamp() {
  try {
    const db = await openDatabase();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['status'], 'readwrite');
      const store = transaction.objectStore('status');
      const request = store.put({
        id: 'last_update',
        timestamp: new Date().toISOString()
      });
      
      request.onsuccess = () => resolve(true);
      request.onerror = (error) => reject(error);
    });
  } catch (error) {
    console.error('Error recording update timestamp:', error);
    return false;
  }
}

// Check for database updates and update if needed
async function checkForDatabaseUpdates() {
  console.log('Checking if license database needs updating...');
  const needsUpdate = await isUpdateNeeded();
  
  if (needsUpdate) {
    console.log('License database update needed. Starting update process...');
    
    try {
      // Set badge to indicate update in progress
      chrome.action.setBadgeText({ text: 'Updt' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' }); // Orange
      
      // Fetch the license index to check for changes
      const licenseList = await fetch('https://scancode-licensedb.aboutcode.org/index.json', {
        cache: 'no-cache' // Force fresh content
      }).then(response => response.json());
      
      // Filter out deprecated licenses
      const licenses = licenseList.filter(obj => !obj.is_deprecated);
      console.log(`Found ${licenses.length} non-deprecated licenses during update check`);
      
      // Store the updated index
      const db = await openDatabase();
      const metadataStore = db.transaction(['metadata'], 'readwrite')
        .objectStore('metadata');
      await new Promise((resolve, reject) => {
        const request = metadataStore.put({ id: 'index', data: licenses });
        request.onsuccess = () => resolve();
        request.onerror = (error) => reject(error);
      });
      
      // Process licenses in batches (reusing logic from preloadLicenseDatabase)
      const batchSize = 50;
      const totalLicenses = licenses.length;
      let processed = 0;
      let failures = 0;
      
      for (let i = 0; i < totalLicenses; i += batchSize) {
        const batch = licenses.slice(i, Math.min(i + batchSize, totalLicenses));
        
        // Process this batch
        await Promise.all(batch.map(async (license) => {
          try {
            // Fetch with no-cache to get fresh content
            const licenseUrl = `https://scancode-licensedb.aboutcode.org/${license.json}`;
            const response = await fetch(licenseUrl, { cache: 'no-cache' });
            
            if (!response.ok) {
              throw new Error(`Failed to fetch ${licenseUrl}: ${response.statusText}`);
            }
            
            const licenseData = await response.json();
            
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
            console.error(`Error processing license ${license.license_key} during update:`, error);
          }
        }));
        
        // Update progress
        processed += batch.length;
        const percentComplete = Math.round((processed / totalLicenses) * 100);
        
        // Update badge to show progress
        chrome.action.setBadgeText({ text: `${percentComplete}%` });
      }
      
      // Record the update timestamp
      await recordUpdateTimestamp();
      
      console.log(`License database update completed. Processed ${processed} licenses with ${failures} failures.`);
      
      // Reset badge
      chrome.action.setBadgeText({ text: 'Diff' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });  // Green
      
      return true;
    } catch (error) {
      console.error('Error updating license database:', error);
      chrome.action.setBadgeText({ text: 'Err' });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336' });  // Red
      
      // Reset badge after a delay
      setTimeout(() => {
        chrome.action.setBadgeText({ text: 'Diff' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      }, 5000);
      
      return false;
    }
  } else {
    console.log('License database is up to date');
    return true;
  }
}

// Register alarm for periodic updates (on install/startup)
function setupPeriodicUpdates() {
  chrome.alarms.create('checkLicenseDbUpdates', {
    periodInMinutes: 60 * 24 // Check daily, but only update if two weeks have passed
  });
  
  // Also do an immediate check on startup
  checkForDatabaseUpdates().catch(err => {
    console.error('Error during startup update check:', err);
  });
}

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkLicenseDbUpdates') {
    checkForDatabaseUpdates().catch(err => {
      console.error('Error during scheduled update check:', err);
    });
  }
});