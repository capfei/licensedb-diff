// Background script entry
'use strict';
console.log('Background script loaded.');

import DiffMatchPatch from "./diff_match_patch.js";

// configuration constants
const CONFIG = {
  scan: {
    maxResults: 10,
    finalThresholdPct: 15,
    baseApproxThresholdPct: 10,
    maxDiffCandidates: 120,
    batchSize: 60,
    longText: { length: 5000, diffTimeout: 0.05, approxAdd: 0, maxDiff: 30 },
    mediumText: { length: 2000, diffTimeout: 0.10, approxAdd: 2, maxDiff: 50 },
    shortText: { diffTimeout: 0.15, approxAdd: 0, maxDiff: 80 }
  },
  quickFilter: {
    minLengthRatio: 0.4,
    maxLengthRatio: 3.5,
    overlapFraction: 0.15
  },
  cache: {
    updateIntervalMs: 14 * 24 * 60 * 60 * 1000
  },
  updates: {
    periodicAlarmMinutes: 60 * 24
  }
};
function updateBadge(color) {
  switch (color) {
    case 'green':
      chrome.action.setBadgeText({ text: 'Diff' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      break;
    case 'red':
      chrome.action.setBadgeText({ text: 'Error' });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
      break;
    case 'orange':
      chrome.action.setBadgeText({ text: 'Load' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });
      break;
    default:
      chrome.action.setBadgeText({ text: '' });
  }
}
const FILTER_OPTIONS = Object.freeze({ LICENSES: 'licenses', EXCEPTIONS: 'exceptions', BOTH: 'both' });
let currentScanFilter = FILTER_OPTIONS.BOTH;
function normalizeFilter(value) {
  return Object.values(FILTER_OPTIONS).includes(value) ? value : FILTER_OPTIONS.BOTH;
}
try {
  chrome.action.setPopup({ popup: 'popup.html' });
} catch (err) {
  console.warn('Popup attach failed:', err);
}

const dmp = new DiffMatchPatch();
// In-memory cache of license term-frequency vectors (populated on demand)
let licenseVectorsCache = null; // { license_key: { word: freq, ... } }

// Track which tabs are currently running scans
const activeScans = new Set();

// Database version - increment when structure changes
const DB_VERSION = 2;
let dbInstance = null;
let dbOpenPromise = null;
/**
 * Open (and create/upgrade) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbOpenPromise) return dbOpenPromise;

  dbOpenPromise = new Promise((resolve, reject) => {
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
      dbInstance = event.target.result;
      dbInstance.onclose = () => { dbInstance = null; dbOpenPromise = null; };
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbOpenPromise = null;
      };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      dbOpenPromise = null;
      reject(`IndexedDB error: ${event.target.errorCode}`);
    };
  });

  return dbOpenPromise;
}

/**
 * Promisify a standard IDB request.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = e => resolve(e.target.result);
    request.onerror = () => reject(request.error);
  });
}

// Check if database is initialized
async function isDatabaseInitialized() {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readonly');
    const store = tx.objectStore('status');
    try {
      const record = await promisifyRequest(store.get('initialization'));
      return !!(record && record.completed === true);
    } catch {
      return false;
    }
  } catch (error) {
    console.error('Error checking database initialization:', error);
    return false;
  }
}

/**
 * Persist the initialization status flag.
 * @returns {Promise<boolean>}
 */
async function markDatabaseInitialized() {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readwrite');
    const store = tx.objectStore('status');
    await promisifyRequest(store.put({
      id: 'initialization',
      completed: true,
      timestamp: new Date().toISOString()
    }));
    return true;
  } catch (error) {
    console.error('Error marking database as initialized:', error);
    return false;
  }
}
async function preloadLicenseDatabase() {
  try {
    // Check if already initialized
    const isInitialized = await isDatabaseInitialized();
    if (isInitialized) {
      console.log('License database already initialized');
      return true;
    }

    console.log('Starting license database initialization...');
    updateBadge("orange");

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
    await promisifyRequest(metadataStore.put({ id: 'index', data: licenses }));

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
          // Normalize license text before storing vectors and diffs
          if (licenseData && licenseData.text) {
            licenseData.text = normalizeLicenseText(licenseData.text);
          }

          // Store in licenses store
          const licenseStore = db.transaction(['licenses'], 'readwrite')
            .objectStore('licenses');
          await promisifyRequest(licenseStore.put({ license_key: license.license_key, data: licenseData }));

          // Pre-calculate and store the license text vector
          if (licenseData.text) {
            const vector = createTextVector(licenseData.text);
            const vectorStore = db.transaction(['vectors'], 'readwrite')
              .objectStore('vectors');
            await promisifyRequest(vectorStore.put({ license_key: license.license_key, data: vector }));
          }
        } catch (error) {
          failures++;
          console.error(`Error processing license ${license.license_key}:`, error);
        }
      })); // correct closure: Promise.all( batch.map(fn )

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
    updateBadge("green");

    console.log(`License database initialization completed. Processed ${processed} licenses with ${failures} failures.`);
    return true;
  } catch (error) {
    console.error('Error initializing license database:', error);
    updateBadge("red");
    return false;
  }
}

// Correct cache write in fetchWithCache
async function fetchWithCache(url, cacheKey, storeName) {
  const db = await openDatabase();
  const transaction = db.transaction([storeName], 'readonly');
  const store = transaction.objectStore(storeName);
  try {
    const cached = await promisifyRequest(store.get(cacheKey));
    if (cached) return cached.data;
  } catch {/* ignore */}

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    console.warn(`Warning: ${url} returned non-JSON content type: ${contentType}`);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`Warning: Failed to parse JSON from ${url}, returning raw text`);
    data = { text };
  }
  if (data && data.text) data.text = normalizeLicenseText(data.text);

  try {
    const writeTx = db.transaction([storeName], 'readwrite');
    const writeStore = writeTx.objectStore(storeName);
    // Use correct key field based on store keyPath
    let record;
    if (storeName === 'licenses') {
      record = { license_key: cacheKey, data };
    } else if (storeName === 'metadata') {
      record = { id: cacheKey, data };
    } else if (storeName === 'vectors') {
      record = { license_key: cacheKey, data };
    } else if (storeName === 'status') {
      record = { id: cacheKey, data };
    } else {
      // fallback generic
      record = { key: cacheKey, data };
    }
    await promisifyRequest(writeStore.put(record));
  } catch {
    /* non-fatal */
  }
  return data;
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
            Promise.all([
              chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => { }),
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
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => { });
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

// Normalize license text before storing
function normalizeLicenseText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\u00a0/g, ' ')        // replace non-breaking spaces
    .replace(/[ \t]{2,}/g, ' ')     // collapse multiple spaces/tabs
    .trim();                        // trim ends
}

function canonicalizeForDiff(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')          // en/em dash -> hyphen
    .replace(/\u00a0/g, ' ')                  // non-breaking space
    .replace(/\n+/g, ' ')                    // collapse newlines
    .replace(/[ \t]+/g, ' ')                  // collapse spaces/tabs
    .trim()
    .toLowerCase();
}

// Prepare text for visual diff (light cleanup, keep original casing)
function prepareDisplayText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function computeDiffSimilarities(diff, lenA, lenB) {
  let same = 0;
  for (const tuple of diff) {
    if (tuple[0] === 0 && tuple[1]) same += tuple[1].length;
  }
  const avgDenom = (lenA + lenB) / 2 || 1;
  const containmentDenom = Math.min(lenA, lenB) || 1;
  const unionDenom = (lenA + lenB - same) || 1;
  return {
    avgPct: (same / avgDenom) * 100,
    containmentPct: (same / containmentDenom) * 100,
    jaccardPct: (same / unionDenom) * 100
  };
}

// Compute character similarity using existing diff (sum of equal segment lengths / average length)
function computeCharSimilarityFromDiff(diff, lenA, lenB) {
  if (!diff || !diff.length) return 0;
  let same = 0;
  for (const tuple of diff) {
    // tuple is a diff_match_patch.Diff object with numeric keys 0 (op) and 1 (text)
    const op = tuple[0];
    const data = tuple[1] || '';
    if (op === 0) same += data.length;
  }
  const denom = (lenA + lenB) / 2 || 1;
  return same / denom;
}

// Quick similarity check for pre-filtering
function quickSimilarityCheck(textVector, licenseVector) {
  const textKeys = Object.keys(textVector);
  const licenseKeys = Object.keys(licenseVector);
  const lengthRatio = textKeys.length / (licenseKeys.length || 1);
  if (lengthRatio < CONFIG.quickFilter.minLengthRatio || lengthRatio > CONFIG.quickFilter.maxLengthRatio) return false;
  const textKeySet = new Set(textKeys);
  let intersection = 0;
  const minNeeded = Math.min(textKeys.length, licenseKeys.length) * CONFIG.quickFilter.overlapFraction; // overlap fraction of smaller set
  for (const k of textKeySet) {
    if (licenseVector[k] !== undefined) {
      intersection++;
      if (intersection >= minNeeded) return true;
    }
  }
  return false;
}

// Approximate character similarity using token overlap without running diff
// We estimate overlapping characters as sum(min(freqA, freqB) * word.length) over shared words
// Returns a fraction (0..1) similar in scale to computeCharSimilarityFromDiff
function approximateCharSimilarity(textVector, licenseVector, wordLenCache, lenSelected, lenLicense) {
  let sharedChars = 0;
  for (const word in textVector) {
    if (licenseVector[word]) {
      const overlapFreq = Math.min(textVector[word], licenseVector[word]);
      const wlen = wordLenCache[word] || word.length; // wordLenCache speeds repeated lookups
      sharedChars += overlapFreq * wlen;
    }
  }
  const denom = (lenSelected + lenLicense) / 2 || 1;
  return sharedChars / denom;
}

// Load all stored vectors once (or as many as available). Missing vectors can be generated lazily.
async function loadAllVectors() {
  if (licenseVectorsCache) return licenseVectorsCache;
  licenseVectorsCache = {};
  try {
    const db = await openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(['vectors'], 'readonly');
      const store = tx.objectStore('vectors');
      const request = store.openCursor();
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          licenseVectorsCache[cursor.key] = cursor.value.data;
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve(); // fail soft
    });
  } catch (e) {
    console.warn('Vector preload skipped due to error:', e);
  }
  return licenseVectorsCache;
}

// Added caches for advanced similarity metrics
let docFreqCache = null;          // { term: documentFrequency }
let totalDocsCache = 0;
const licenseShingleCache = {};   // { license_key: Set<string> }

// Build document frequency map from all license vectors (presence-based)
async function buildDocFreq() {
  if (docFreqCache) return docFreqCache;
  await loadAllVectors();
  docFreqCache = {};
  const seen = licenseVectorsCache || {};
  totalDocsCache = 0;
  for (const lic in seen) {
    const vec = seen[lic];
    if (!vec) continue;
    totalDocsCache++;
    for (const term in vec) {
      docFreqCache[term] = (docFreqCache[term] || 0) + 1;
    }
  }
  return docFreqCache;
}

function buildTfidfVector(termFreq, docFreq, totalDocs) {
  const vec = {};
  for (const term in termFreq) {
    const tf = termFreq[term];
    const df = docFreq[term] || 1;
    // log(1 + N/df) to keep values in a modest range
    const idf = Math.log(1 + totalDocs / df);
    vec[term] = tf * idf;
  }
  return vec;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const t in a) {
    const av = a[t];
    na += av * av;
    if (b[t]) dot += av * b[t];
  }
  for (const t in b) {
    const bv = b[t];
    nb += bv * bv;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Overlap coefficient (containment): |A ∩ B| / min(|A|, |B|)
function overlapCoefficient(aKeysArr, bKeysArr) {
  if (!aKeysArr.length || !bKeysArr.length) return 0;
  const small = aKeysArr.length < bKeysArr.length ? aKeysArr : bKeysArr;
  const largeSet = new Set(aKeysArr.length < bKeysArr.length ? bKeysArr : aKeysArr);
  let inter = 0;
  for (const k of small) if (largeSet.has(k)) inter++;
  return inter / small.length;
}

// 5-word shingles (can tweak k via arg)
function buildShingles(words, k = 5) {
  const out = new Set();
  if (words.length < k) return out;
  for (let i = 0; i <= words.length - k; i++) {
    out.add(words.slice(i, i + k).join(' '));
  }
  return out;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  return inter / (setA.size + setB.size - inter || 1);
}

// Load user settings (with defaults from CONFIG)
async function loadUserSettings() {
  const defaults = {
    maxResults: CONFIG.scan.maxResults,
    minSimilarityPct: CONFIG.scan.finalThresholdPct,
    scanFilter: FILTER_OPTIONS.BOTH
  };
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.get(defaults, (items) => {
        currentScanFilter = normalizeFilter(items?.scanFilter);
        resolve(items || defaults);
      });
    } catch {
      currentScanFilter = defaults.scanFilter;
      resolve(defaults);
    }
  });
}

/**
 * Main similarity pipeline: approximate prefilter then diff refinement.
 * Ensures up to CONFIG.scan.maxResults returned; fills remaining with lower scores if needed.
 * @param {string} text Raw user-selected text
 * @param {(progress: {checked:number,total:number,promising:number,message:string})=>void} sendProgress progress callback
 * @returns {Promise<Array<{license:string,name:string,spdx:string,charSimilarity:string,score:string,diff:string,link:string}>>}
 */
async function fetchLicenses(text, sendProgress, options = {}) {
  const scanFilter = normalizeFilter(options.filter || currentScanFilter);
  const originalSelected = text;
  // Ensure database initialized
  if (!(await isDatabaseInitialized())) {
    sendProgress({ checked: 0, total: 1, promising: 0, message: 'Initializing license database...' });
    await preloadLicenseDatabase();
  }

  try {
    // Load metadata index (cached)
    const licenseList = await fetchWithCache(
      'https://scancode-licensedb.aboutcode.org/index.json',
      'index',
      'metadata'
    );
    const filteredLicenses = licenseList
      .filter(l => !l.is_deprecated)
      .filter(l => {
        if (scanFilter === FILTER_OPTIONS.LICENSES) return !l.is_exception;
        if (scanFilter === FILTER_OPTIONS.EXCEPTIONS) return l.is_exception === true;
        return true;
      });
    if (!filteredLicenses.length) {
      console.warn('[LicenseMatch] No entries match filter', scanFilter);
      return [];
    }
    const licenses = filteredLicenses;

    // User settings
    const userSettings = await loadUserSettings();
    const MAX_RESULTS = Math.max(1, Math.min(100, parseInt(userSettings.maxResults ?? CONFIG.scan.maxResults, 10)));
    const FINAL_THRESHOLD = Math.max(0, Math.min(100, Number(userSettings.minSimilarityPct ?? CONFIG.scan.finalThresholdPct)));

    // Internal knobs
    const BASE_APPROX_THRESHOLD = CONFIG.scan.baseApproxThresholdPct;
    const MAX_DIFF_CANDIDATES = CONFIG.scan.maxDiffCandidates;
    const batchSize = CONFIG.scan.batchSize;

    // Normalize selection
    const selectedNormalized = normalizeLicenseText(text);
    const selectedLength = selectedNormalized.length;
    const canonSelected = canonicalizeForDiff(selectedNormalized);
    const isLongSelection = selectedLength > CONFIG.scan.longText.length;

    // Selection fingerprint (debug)
    (function fingerprint() {
      try {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < canonSelected.length; i++) {
          h ^= canonSelected.charCodeAt(i);
          h = (h * 16777619) >>> 0;
        }
        console.log('[LicenseMatch][SelFingerprint]', {
          selLen: selectedNormalized.length,
            canonLen: canonSelected.length,
            hash: 'fnv32-' + h.toString(16)
        });
      } catch (_) { /* ignore */ }
    })();

    // Dynamic thresholds
    let approxThreshold;
    let dynamicMaxDiff;
    if (selectedLength > CONFIG.scan.longText.length) {
      approxThreshold = BASE_APPROX_THRESHOLD + CONFIG.scan.longText.approxAdd;
      dynamicMaxDiff = CONFIG.scan.longText.maxDiff;
    } else if (selectedLength > CONFIG.scan.mediumText.length) {
      approxThreshold = BASE_APPROX_THRESHOLD + CONFIG.scan.mediumText.approxAdd;
      dynamicMaxDiff = CONFIG.scan.mediumText.maxDiff;
    } else {
      approxThreshold = BASE_APPROX_THRESHOLD + CONFIG.scan.shortText.approxAdd;
      dynamicMaxDiff = CONFIG.scan.shortText.maxDiff;
    }
    dynamicMaxDiff = Math.min(dynamicMaxDiff, MAX_DIFF_CANDIDATES);

    // Selection vector + caches
    const textVector = createTextVector(selectedNormalized);
    const selWords = Object.keys(textVector);

    await loadAllVectors();
    await buildDocFreq().catch(() => {});

    const selTfidf = docFreqCache ? buildTfidfVector(textVector, docFreqCache, totalDocsCache || 1) : null;
    const selShingles = buildShingles(selWords, 5);

    const wordLenCache = {};
    for (const w in textVector) wordLenCache[w] = w.length;

    // Progress counters
    const totalLicenses = licenses.length;
    let checkedLicenses = 0;
    let approxPromising = 0;
    await sendProgress({ checked: 0, total: totalLicenses, promising: 0, message: 'Scanning (approx phase)...' });

    const approxCandidates = [];
    let quickPass = 0, quickFail = 0, approxBelow = 0;
    const startApprox = performance.now();

    // approximate pass
    for (let i = 0; i < licenses.length; i += batchSize) {
      const batch = licenses.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async (lic) => {
        try {
          const licData = await fetchWithCache(
            `https://scancode-licensedb.aboutcode.org/${lic.json}`,
            lic.license_key,
            'licenses'
          ).catch(() => null);
          if (!licData || !licData.text) return null;

          const licenseTextNorm = normalizeLicenseText(licData.text);
          // Cache canonical once
          const canonLic = canonicalizeForDiff(licenseTextNorm);
          let licenseVector = licenseVectorsCache[lic.license_key];
          if (!licenseVector) {
            licenseVector = createTextVector(licenseTextNorm);
            licenseVectorsCache[lic.license_key] = licenseVector;
          }

        // Quick structural filter
        if (!quickSimilarityCheck(textVector, licenseVector)) {
          quickFail++;
          return null;
        }
        quickPass++;

        // Approx char similarity (%)
        const approxPct = approximateCharSimilarity(
          textVector, licenseVector, wordLenCache,
          selectedLength, licenseTextNorm.length
        ) * 100;

        // Hybrid light metrics
        const licWords = Object.keys(licenseVector);
        const overlapCoeffVal = overlapCoefficient(selWords, licWords);
        let cosineVal = 0;
        if (selTfidf) {
          const licTfidf = buildTfidfVector(licenseVector, docFreqCache, totalDocsCache || 1);
          cosineVal = cosine(selTfidf, licTfidf);
        }
        let shingleJac = 0;
        if (selShingles.size) {
          let licShingles = licenseShingleCache[lic.license_key];
          if (!licShingles) {
            licShingles = buildShingles(licWords, 5);
            licenseShingleCache[lic.license_key] = licShingles;
          }
          if (licShingles.size) shingleJac = jaccard(selShingles, licShingles);
        }

        // Segment-based similarity only for long selections (skip for short to keep fast)
        const segSimPct = isLongSelection ? (computeSegmentSimilarity(canonLic, canonSelected) * 100) : 0;

        // Blend: conservative weighted blend. For short selections, ignore segSimPct.
        const combined = isLongSelection
          ? Math.max(
              segSimPct,
              (
                0.42 * (approxPct) +
                0.28 * (overlapCoeffVal * 100) +
                0.18 * (cosineVal * 100) +
                0.12 * (shingleJac * 100)
              )
            )
          : (
              0.50 * (approxPct) +
              0.30 * (overlapCoeffVal * 100) +
              0.20 * (cosineVal * 100)
            );

        // Pass if any component is reasonably good
        const pass =
          combined >= (approxThreshold - 1) ||
          approxPct >= approxThreshold ||
          overlapCoeffVal >= 0.42 ||
          cosineVal >= 0.22 ||
          (isLongSelection && segSimPct >= (approxThreshold + 2));

        if (!pass) {
          approxBelow++;
          return null;
        }

        return {
          license: lic.license_key,
          name: licData.name,
          spdx: lic.spdx_license_key,
          approxSimilarity: combined,
          rawApprox: approxPct,
          overlapCoeff: overlapCoeffVal,
          cosine: cosineVal,
          shingleJac,
          segSimPct,
          licenseText: licenseTextNorm,
          canonLicense: canonLic
        };
        } catch {
          return null;
        }
      })); // correct closure: Promise.all( batch.map(fn )

      // Small cooperative yield to avoid blocking
      await new Promise(r => setTimeout(r, 0));

      for (const r of batchResults) if (r) approxCandidates.push(r);
      checkedLicenses += batch.length;
      approxPromising = approxCandidates.length;
      await sendProgress({
        checked: checkedLicenses,
        total: totalLicenses,
        promising: approxPromising,
        message: 'Scanning (approx phase)...'
      });
    }

    console.log(
      `[LicenseMatch][Approx] licenses=${totalLicenses} quickPass=${quickPass} quickFail=${quickFail} kept=${approxCandidates.length} ` +
      `approxBelow=${approxBelow} threshold=${approxThreshold} timeMs=${(performance.now() - startApprox).toFixed(1)}`
    );

    // Fallback if very few candidates
    if (approxCandidates.length < 5) {
      console.warn(`[LicenseMatch] Fallback (<5 candidates).`);
      const textTokenSet = new Set(selWords);
      const overlapScores = [];
      for (const lic of licenses) {
        try {
          let vec = licenseVectorsCache[lic.license_key];
          if (!vec) {
            const licData = await fetchWithCache(
              `https://scancode-licensedb.aboutcode.org/${lic.json}`,
              lic.license_key,
              'licenses'
            ).catch(() => null);
            if (!licData || !licData.text) continue;
            const norm = normalizeLicenseText(licData.text);
            vec = createTextVector(norm);
            licenseVectorsCache[lic.license_key] = vec;
          }
          const licKeys = Object.keys(vec);
          let overlapCount = 0;
          for (const t of licKeys) {
            if (textTokenSet.has(t)) overlapCount++;
          }
          if (!overlapCount) continue;
          const overlapCoeffVal = overlapCount / Math.min(textTokenSet.size, licKeys.length);
          overlapScores.push({ lic, overlapCoeffVal, overlapCount });
        } catch { /* ignore */ }
      }
      overlapScores.sort((a, b) => b.overlapCoeffVal - a.overlapCoeffVal || b.overlapCount - a.overlapCount);
      for (const s of overlapScores.slice(0, 40)) {
        try {
          const licData = await fetchWithCache(
            `https://scancode-licensedb.aboutcode.org/${s.lic.json}`,
            s.lic.license_key,
            'licenses'
          );
          if (!licData || !licData.text) continue;
          const norm = normalizeLicenseText(licData.text);
          approxCandidates.push({
            license: s.lic.license_key,
            name: licData.name,
            spdx: s.lic.spdx_license_key,
            approxSimilarity: s.overlapCoeffVal * 100,
            licenseText: norm,
            overlapCoeff: s.overlapCoeffVal
          });
        } catch { /* ignore */ }
      }
      console.warn(`[LicenseMatch] Fallback expanded candidates to ${approxCandidates.length}.`);
    }

    // Sort by strongest signal: for long, consider segSim; for short, use approxSimilarity
    approxCandidates.sort((a, b) => {
      const aKey = isLongSelection ? Math.max(a.approxSimilarity || 0, a.segSimPct || 0) : (a.approxSimilarity || 0);
      const bKey = isLongSelection ? Math.max(b.approxSimilarity || 0, b.segSimPct || 0) : (b.approxSimilarity || 0);
      return bKey - aKey;
    });

    // Slightly widen diff pool for longer texts
    if (selectedLength > CONFIG.scan.mediumText.length) {
      dynamicMaxDiff = Math.min(dynamicMaxDiff + 10, MAX_DIFF_CANDIDATES);
    }

    // Diff cap (simple)
    let effectiveDiffCap = Math.min(MAX_RESULTS * 2, dynamicMaxDiff, MAX_DIFF_CANDIDATES);

    // Prepare diff
    const prevTimeout = dmp.Diff_Timeout;
    let baseDiffTimeout;
    if (selectedLength > CONFIG.scan.longText.length) baseDiffTimeout = 0.08;
    else if (selectedLength > CONFIG.scan.mediumText.length) baseDiffTimeout = 0.14;
    else baseDiffTimeout = 0.18;
    dmp.Diff_Timeout = baseDiffTimeout;

    const DIFF_BUDGET_MS = selectedLength > 10000 ? 2200 :
                         selectedLength > 6000  ? 2600 :
                         selectedLength > 3000  ? 3000 : 3200;

    const refined = [];
    const startDiffPhase = performance.now();
    let escalationsUsed = 0;
    const MAX_ESCALATIONS = 10;
    let diffEvaluated = 0;
    let budgetExceeded = false; // track budget exhaustion

    function shouldEscalate(candidate, sims) {
      if (sims.containmentPct >= 5) return false;
      return (candidate.approxSimilarity || 0) >= (approxThreshold + 12);
    }

    async function runDiffs(cands) {
      for (let idx = 0; idx < cands.length; idx++) {
        if ((performance.now() - startDiffPhase) > DIFF_BUDGET_MS) {
          console.warn('[LicenseMatch][Diff] Budget exceeded; stopping.');
          budgetExceeded = true;
          break;
        }
        if (idx >= effectiveDiffCap) break;

        const cand = cands[idx];
        try {
          const canonLic = cand.canonLicense || canonicalizeForDiff(cand.licenseText);

          // Cap timeout even for top candidates to avoid stalling
          const saved = dmp.Diff_Timeout;
          if (isLongSelection && idx < 3) {
            dmp.Diff_Timeout = Math.max(baseDiffTimeout, 0.8); // was 0 (unlimited), now capped
          } else {
            dmp.Diff_Timeout = baseDiffTimeout;
          }

          let diffChars = dmp.diff_main(canonLic, canonSelected);
          dmp.diff_cleanupSemantic(diffChars);
          let sims = computeDiffSimilarities(diffChars, canonLic.length, canonSelected.length);

          // If segment similarity was good but containment low, try one escalation (only for long selections)
          if (isLongSelection && cand.segSimPct >= (approxThreshold + 6) && sims.containmentPct < FINAL_THRESHOLD) {
            dmp.Diff_Timeout = Math.max(saved, 0.6);
            diffChars = dmp.diff_main(canonLic, canonSelected);
            dmp.diff_cleanupSemantic(diffChars);
            sims = computeDiffSimilarities(diffChars, canonLic.length, canonSelected.length);
          }

          dmp.Diff_Timeout = saved;

          const finalScore =
            0.5 * sims.containmentPct +
            0.3 * sims.avgPct +
            0.2 * sims.jaccardPct;

          const passes =
            sims.containmentPct >= FINAL_THRESHOLD ||
            finalScore >= FINAL_THRESHOLD;

          if (passes) {
            let displayDiffHtml;
            try {
              displayDiffHtml = generateStableDisplayDiff(cand.licenseText, originalSelected);
            } catch {
              displayDiffHtml = '(diff error)';
            }
            refined.push({
              license: cand.license,
              name: cand.name,
              spdx: cand.spdx,
              charSimilarity: finalScore.toFixed(2),
              diff: displayDiffHtml,
              diffMetrics: {
                containment: sims.containmentPct.toFixed(2),
                avg: sims.avgPct.toFixed(2),
                jaccard: sims.jaccardPct.toFixed(2)
              },
              score: finalScore.toFixed(2),
              link: `https://scancode-licensedb.aboutcode.org/${cand.license}.html`
            });
          }
        } catch (e) {
          console.error('[LicenseMatch][DiffErr]', cand?.license, e);
        }

        diffEvaluated++;
        if (refined.length >= MAX_RESULTS) break;

        // Yield periodically
        if (idx % 10 === 0) await new Promise(r => setTimeout(r, 0));

        if (diffEvaluated % 15 === 0) {
          await sendProgress({
            checked: checkedLicenses,
            total: totalLicenses,
            promising: cands.length,
            message: `Refining ${diffEvaluated}/${cands.length}...`
          });
        }
      }
    }

    const toRefine = approxCandidates.slice(0, Math.min(effectiveDiffCap, approxCandidates.length));
    console.log(
      `[LicenseMatch][SelectDiff] selectionLen=${selectedLength} approxCandidates=${approxCandidates.length} ` +
      `refining=${toRefine.length} cap=${effectiveDiffCap} timeout=${baseDiffTimeout} budgetMs=${DIFF_BUDGET_MS}`
    );
    await runDiffs(toRefine);

    if (!budgetExceeded &&
      refined.length < Math.max(2, Math.floor(MAX_RESULTS / 2)) &&
      (performance.now() - startDiffPhase) < (DIFF_BUDGET_MS * 0.6) &&
      approxCandidates.length > toRefine.length) {

      const expansion = approxCandidates.slice(
        toRefine.length,
        Math.min(approxCandidates.length, toRefine.length + (MAX_RESULTS * 2))
      );
      if (expansion.length) {
        await sendProgress({
          checked: checkedLicenses,
          total: totalLicenses,
          promising: expansion.length,
          message: `Expanding refinement (+${expansion.length})...`
        });
        await runDiffs(expansion);
      }
    }

    dmp.Diff_Timeout = prevTimeout;

    console.log('[LicenseMatch][DiffStats]', {
      diffEvaluated,
      refined: refined.length,
      escalationsUsed,
      timeMs: (performance.now() - startDiffPhase).toFixed(1)
    });

    await sendProgress({
      checked: checkedLicenses,
      total: totalLicenses,
      promising: approxCandidates.length,
      message: refined.length ? `Completed with ${refined.length} match(es).` : 'Completed. No significant matches.'
    });

    return refined.slice(0, MAX_RESULTS);
  } catch (err) {
    console.error('Error in fetchLicenses:', err);
    throw err;
  }
}

// Process a license check request
async function processLicenseCheck(tabId, selectedText, scanFilter = FILTER_OPTIONS.BOTH) {
  if (!tabId) {
    console.error('processLicenseCheck called without a tab ID.');
    return;
  }

  if (!selectedText || selectedText.trim().length === 0) {
    showNotification(tabId, 'Please select some text to compare with licenses.', 'warning');
    return;
  }

  if (activeScans.has(tabId)) {
    showNotification(tabId, 'Already processing a license check. Please wait...', 'info');
    return;
  }

  // Mark this tab as having an active scan
  activeScans.add(tabId);

  try {
    // Make sure content script is available
    const ready = await ensureContentScript(tabId);
    if (!ready) {
      console.error('Content script not available after injection attempts.');
      return;
    }
    // Show UI and clear previous results with retry
    for (const m of ['showUI', 'clearResults']) {
      try {
        await sendMessageToTab(tabId, { action: m });
      } catch (msgErr) {
        console.warn('Retrying message', m, 'after brief delay due to', msgErr.message);
        await new Promise(r => setTimeout(r, 100));
        await sendMessageToTab(tabId, { action: m });
      }
    }

    // Progress callback for reporting scan progress
    const sendProgress = async (progress) => {
      try {
        await sendMessageToTab(tabId, {
          action: 'progressUpdate',
          progress
        });
      } catch (error) {
        console.error('Error sending progress update:', error);
      }
    };

    // Fetch and compare licenses
    const matches = await fetchLicenses(selectedText, sendProgress, { filter: normalizeFilter(scanFilter) });

    if (matches && matches.length > 0) {
      matches.sort((a, b) => {
        const aScore = Number.parseFloat(a?.charSimilarity ?? a?.score ?? 0) || 0;
        const bScore = Number.parseFloat(b?.charSimilarity ?? b?.score ?? 0) || 0;
        return bScore - aScore;
      });
      console.log('Sending showResults with', matches.length, 'matches. Top license:', matches[0]?.license);
      // Report the matches to the content script
      await sendMessageToTab(tabId, {
        action: 'showResults',
        matches
      });
    } else {
      await sendMessageToTab(tabId, {
        action: 'showError',
        error: 'No significant license matches found.'
      });
    }
  } catch (error) {
    console.error('Error processing license check:', error);
    try {
      await sendMessageToTab(tabId, {
        action: 'showError',
        error: error.message || 'An unknown error occurred'
      });
    } catch (err) {
      console.error('Error showing error notification:', err);
    }
  } finally {
    // Remove this tab from active scans
    activeScans.delete(tabId);
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
  if (message?.action === 'openExternal' && typeof message.url === 'string') {
    chrome.tabs.create({ url: message.url }).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      console.error('openExternal failed:', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true; // keep the message channel open for async response
  }
  if (message.action === 'checkLicense') {
    const selectedText = message.text;
    const scanFilter = normalizeFilter(message.filter || currentScanFilter);

    const startProcessing = (tabId) => {
      processLicenseCheck(tabId, selectedText, scanFilter)
        .then(() => {
          sendResponse({ status: 'complete' });
        })
        .catch((error) => {
          console.error('processLicenseCheck failed:', error);
          sendResponse({ status: 'error', error: error?.message || 'Unknown error' });
        });
    };

    // Store the tab ID that initiated the request
    const senderTabId = sender.tab ? sender.tab.id : null;

    if (!senderTabId) {
      // If no tab ID is available (e.g., sent from popup), get the current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No active tabs found';
          console.error('Error getting active tab:', errMsg);
          sendResponse({ status: 'error', error: errMsg });
          return;
        }

        startProcessing(tabs[0].id);
      });
    } else {
      startProcessing(senderTabId);
    }

    return true; // Keep the port open while processing completes
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
  } else if (message.action === 'startScanWithFilter') {
    const chosenFilter = normalizeFilter(message.filter);
    currentScanFilter = chosenFilter;
    chrome.storage?.sync?.set({ scanFilter: chosenFilter }, () => { initiateScanForActiveTab(chosenFilter); });
    sendResponse({ started: true });
    return true;
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
    const cached = await getCachedLicenseDbVersion();
    if (cached && cached.timestamp) {
      const ageMs = Date.now() - new Date(cached.timestamp).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return cached.version || null; // cache < 1 day
    }
    // Simple heuristic: fetch index.json and derive a hash/length to act as a pseudo version
    const resp = await fetch('https://scancode-licensedb.aboutcode.org/index.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Failed to fetch license index for version');
    const text = await resp.text();
    // lightweight hash
    let hash = 0; for (let i = 0; i < text.length; i++) { hash = (hash * 31 + text.charCodeAt(i)) >>> 0; }
    const version = `idx-${hash}-${text.length}`;
    await cacheLicenseDbVersion(version);
    return version;
  } catch (e) {
    console.warn('Could not determine LicenseDB version:', e.message || e);
    return null;
  }
}

// Get the cached LicenseDB version
async function getCachedLicenseDbVersion() {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readonly');
    const store = tx.objectStore('status');
    try {
      return await promisifyRequest(store.get('licensedb_version'));
    } catch { return null; }
  } catch (error) {
    console.error('Error getting cached LicenseDB version:', error);
    return null;
  }
}

async function cacheLicenseDbVersion(version) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readwrite');
    const store = tx.objectStore('status');
    await promisifyRequest(store.put({ id: 'licensedb_version', version, timestamp: new Date().toISOString() }));
  } catch (e) {
    // non-fatal
  }
}

// Force update the database (manual trigger from options page)
async function forceUpdateDatabase() {
  try {
    // Set badge to indicate update in progress
    updateBadge("orange");

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
    console.log(`Found ${licenses.length} non-deprecated licenses`);

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
          if (licenseData && licenseData.text) {
            licenseData.text = normalizeLicenseText(licenseData.text);
          }

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
    updateBadge("green");

    return true;
  } catch (error) {
    console.error('Error updating database:', error);

    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);

    // Error badge and then reset
    updateBadge("red");

    setTimeout(() => {
      updateBadge("green");
    }, 5000);

    throw error;
  }
}

// Reset database (completely delete and reinitialize)
async function resetDatabase() {
  try {
    // Set badge to indicate reset in progress
    updateBadge("orange");

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
    updateBadge("green");

    return true;
  } catch (error) {
    console.error('Error resetting database:', error);

    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);

    // Reset badge
    updateBadge("red");

    setTimeout(() => {
      updateBadge("green");
    }, 5000);

    throw error;
  }
}

// Record the timestamp of the current update
async function recordUpdateTimestamp() {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['status'], 'readwrite');
      const store = tx.objectStore('status');
      const req = store.put({ id: 'last_update', timestamp: new Date().toISOString() });
      req.onsuccess = () => resolve(true);
      req.onerror = (error) => reject(error);
    });
  } catch (error) {
    console.error('Error recording update timestamp:', error);
    return false;
  }
}

// Function to send progress updates to the options page
function sendProgressUpdate(progress, message, complete = false) {
  try {
    chrome.runtime.sendMessage({
      action: 'updateProgress',
      progress,
      message,
      complete
    });
  } catch (err) {
    console.warn('sendProgressUpdate failed:', err);
  }
}

// Update the action click handler to ensure connection before execution
chrome.action.onClicked.addListener(async (tab) => {
  await handleActionClick(tab, currentScanFilter);
});

async function initiateScanForActiveTab(filterChoice) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await handleActionClick(tab, filterChoice);
    else console.warn('No active tab for scan.');
  } catch (err) {
    console.error('initiateScanForActiveTab failed:', err);
  }
}

async function handleActionClick(tab, filterChoice) {
  try {
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('edge://')) {
      console.warn('Cannot run on this page type:', url);
      return;
    }
    const results = await chrome.scripting.executeScript({
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
        } catch {
          /* ignore frame errors */
        }
        return null;
      }
    });
    // Pick longest non-null selection
    const candidates = results.map(r => r.result).filter(r => r && r.text && r.text.trim());
    if (candidates.length === 0) {
      showNotification(tab.id, 'Please select text before running license check.', 'warning');
      return;
    }
    const best = candidates.reduce((a, b) => (b.text.length > a.text.length ? b : a));

    // Send single message to existing handler (adds iframe metadata for future use)
    // Directly initiate processing instead of round-trip messaging
    sendMessageToTab(tab.id, { action: 'showUI' })
      .catch(() => Promise.resolve())
      .finally(() => {
        processLicenseCheck(tab.id, best.text, filterChoice);
      });
  } catch (err) {
    console.error('Selection collection error:', err);
    showNotification(tab.id, 'Error gathering selection: ' + (err.message || 'Unknown error'), 'error');
  }
}

// prime current filter from stored settings
loadUserSettings().catch(err => console.warn('Settings preload failed:', err));

async function ensureDatabaseReady(context = 'startup') {
  try {
    if (!(await isDatabaseInitialized())) {
      console.log(`[LicenseMatch] Database missing (${context}); initializing.`);
      await preloadLicenseDatabase();
    }
  } catch (err) {
    console.error(`ensureDatabaseReady (${context}) failed:`, err);
  }
}

ensureDatabaseReady('background-load');

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[LicenseMatch] onInstalled:', details.reason);
  if (details.reason === 'update') {
    // Reset badge
    updateBadge("green");
  }
  await ensureDatabaseReady('onInstalled');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDatabaseReady('onStartup');
});

function generateStableDisplayDiff(licenseText, selectionText) {
  const originalTimeout = dmp.Diff_Timeout;
  const displayA = prepareDisplayText(licenseText);
  const displayB = prepareDisplayText(selectionText);
  const canonA = canonicalizeForDiff(displayA);
  const canonB = canonicalizeForDiff(displayB);

  const isDegenerate = (diff, aLen, bLen) =>
    Array.isArray(diff) &&
    diff.length === 2 &&
    (Array.isArray(diff[0]) ? diff[0][0] : diff[0]?.op ?? diff[0]?.operation ?? diff[0]?.type ?? diff[0]?.[0]) === -1 &&
    (Array.isArray(diff[1]) ? diff[1][0] : diff[1]?.op ?? diff[1]?.operation ?? diff[1]?.type ?? diff[1]?.[0]) === 1 &&
    (Array.isArray(diff[0]) ? diff[0][1] : diff[0]?.text ?? diff[0]?.data ?? '')?.length === aLen &&
    (Array.isArray(diff[1]) ? diff[1][1] : diff[1]?.text ?? diff[1]?.data ?? '')?.length === bLen;

  const hasEqual = (diff) => Array.isArray(diff) && diff.some((d) => {
    const op = Array.isArray(d) ? d[0] : d?.op ?? d?.operation ?? d?.type ?? d?.[0];
    return op === 0;
  });

  const hasMeaningfulOverlap = (diff, lenA, lenB) => {
    if (!Array.isArray(diff) || !diff.length) return false;
    const sims = computeDiffSimilarities(diff, lenA, lenB);
    return sims.containmentPct >= 3 || sims.avgPct >= 3;
  };

  const attemptDiff = () => {
    const timeouts = [Math.max(originalTimeout || 0, 1), 4, 0];
    const attempts = [
      { a: displayA, b: displayB, mode: 'chars' },
      { a: displayA, b: displayB, mode: 'lines' },
      { a: canonA, b: canonB, mode: 'chars' },
      { a: canonA, b: canonB, mode: 'lines' }
    ];
    for (const { a, b, mode } of attempts) {
      for (const timeout of timeouts) {
        try {
          const diff = runDisplayDiff(a, b, timeout, mode);
          if (isDegenerate(diff, a.length, b.length)) continue;
          if (!hasEqual(diff) || !hasMeaningfulOverlap(diff, a.length, b.length)) continue;
          return diff;
        } catch (err) {
          console.warn(`[LicenseMatch][DisplayDiff] mode=${mode} timeout=${timeout} failed`, err);
        }
      }
    }
    throw new Error('Diff attempts exhausted');
  };

  try {
    const diffResult = attemptDiff();
    return renderDiffHtml(diffResult);
  } catch (err) {
    console.warn('[LicenseMatch][DisplayDiff] Falling back to raw text:', err);
    return (
      '<div class="ldiff-error">Diff rendering failed. Showing full texts.</div>' +
      `<div class="ldiff-preview"><strong>Selected text:</strong><pre>${escapeHtml(displayB)}</pre></div>` +
      `<div class="ldiff-preview"><strong>Reference text:</strong><pre>${escapeHtml(displayA)}</pre></div>`
    );
  } finally {
    dmp.Diff_Timeout = originalTimeout;
  }
}

function runDisplayDiff(a, b, timeout, mode = 'lines') {
  const previous = dmp.Diff_Timeout;
  try {
    dmp.Diff_Timeout = timeout;
    let diff;
    if (mode === 'lines') {
      const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
      diff = dmp.diff_main(chars1, chars2, false);
      dmp.diff_charsToLines_(diff, lineArray);
    } else {
      diff = dmp.diff_main(a, b, false);
    }
    dmp.diff_cleanupSemantic(diff);
    return diff;
  } finally {
    dmp.Diff_Timeout = previous;
  }
}

function renderDiffHtml(diff) {
  if (!Array.isArray(diff)) throw new Error('Invalid diff payload');
  const normalizeEntry = (entry) => {
    if (!entry) return null;
    if (Array.isArray(entry)) return { op: entry[0], data: String(entry[1] ?? '') };
    if (typeof entry === 'object') {
      const op = entry.op ?? entry.operation ?? entry.type ?? entry[0];
      const data = entry.text ?? entry.data ?? entry[1];
      if (op === undefined || data === undefined) return null;
      return { op, data: String(data) };
    }
    return null;
  };
  const sanitized = diff.map(normalizeEntry).filter(Boolean).map(({ op, data }) => [op, data]);
  if (!sanitized.length) throw new Error('Empty diff after normalization');

  const escapeHtmlFragment = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
  const listLinePattern = /^\s*(?:\(?\d+\)|\d+[.)]|[a-zA-Z][.)]|[-*•])\s+/;
  const shouldForceBreak = (text, newlineIdx, runLength) => {
    if (runLength !== 1) return false;
    const nextSlice = text.slice(newlineIdx + 1);
    const nextLine = nextSlice.split('\n', 1)[0] || '';
    return listLinePattern.test(nextLine);
  };
  const formatDiffText = (text) => {
    if (!text) return '';
    let out = '';
    let lastIndex = 0;
    text.replace(/\n+/g, (match, idx) => {
      if (idx > lastIndex) out += escapeHtmlFragment(text.slice(lastIndex, idx));
      out += match.length === 1
        ? (shouldForceBreak(text, idx, match.length) ? '<br>' : ' ')
        : '<br>'.repeat(match.length);
      lastIndex = idx + match.length;
      return match;
    });
    if (lastIndex < text.length) out += escapeHtmlFragment(text.slice(lastIndex));
    return out;
  };
  const renderBody = (op, chunk) => {
    if (!chunk) return '';
    const formatted = formatDiffText(chunk);
    const whitespaceOnly = !/\S/.test(chunk);
    if (op === 1 && !whitespaceOnly) return `<ins>${formatted}</ins>`;
    if (op === -1 && !whitespaceOnly) return `<del>${formatted}</del>`;
    if (op === 0 && !whitespaceOnly) return `<span>${formatted}</span>`;
    return `<span></span>`;
  };
  const viewable = sanitized; // include deletions again
  if (!viewable.length) throw new Error('Empty diff after filtering viewable segments');
  const html = viewable.map(([op, data]) => renderBody(op, data)).join('');
  return `<div class="ldiff-output" id="outputdiv">${html}</div>`;
}
