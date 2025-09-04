// Background script entry
'use strict';
console.log('Background script loaded.');

chrome.action.setBadgeText({ text: 'Diff' });

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

let originTabId; // Store the ID of the tab that initiated the license check
const dmp = new DiffMatchPatch();
// In-memory cache of license term-frequency vectors (populated on demand)
let licenseVectorsCache = null; // { license_key: { word: freq, ... } }

// Track which tabs are currently running scans
const activeScans = new Set();

// Database version - increment when structure changes
const DB_VERSION = 2;

/**
 * Open (and create/upgrade) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
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
    .replace(/[ \t]+/g, ' ')                  // collapse spaces/tabs
    .replace(/\n{2,}/g, '\n')                 // collapse blank lines
    .trim()
    .toLowerCase();
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

// === Added caches for advanced similarity metrics ===
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
    minSimilarityPct: CONFIG.scan.finalThresholdPct
  };
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.get(defaults, (items) => resolve(items || defaults));
    } catch {
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
async function fetchLicenses(text, sendProgress) {
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
    const licenses = licenseList.filter(l => !l.is_deprecated);

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
    sendProgress({ checked: 0, total: totalLicenses, promising: 0, message: 'Scanning (approx phase)...' });

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

          const combined = (
            0.45 * (approxPct / 100) +
            0.30 * overlapCoeffVal +
            0.15 * cosineVal +
            0.10 * shingleJac
          ) * 100;

          const pass =
            approxPct >= approxThreshold ||
            combined >= (approxThreshold - 2) ||
            overlapCoeffVal >= 0.45 ||
            cosineVal >= 0.25;

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
            licenseText: licenseTextNorm
          };
        } catch {
          return null;
        }
      }));

      for (const r of batchResults) if (r) approxCandidates.push(r);
      checkedLicenses += batch.length;
      approxPromising = approxCandidates.length;
      sendProgress({
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

    // Sort by approximate similarity and trim pool
    approxCandidates.sort((a, b) => b.approxSimilarity - a.approxSimilarity);
    const MAX_APPROX_POOL = 400;
    if (approxCandidates.length > MAX_APPROX_POOL) approxCandidates.length = MAX_APPROX_POOL;

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

    function shouldEscalate(candidate, sims) {
      if (sims.containmentPct >= 5) return false;
      return (candidate.approxSimilarity || 0) >= (approxThreshold + 12);
    }

    async function runDiffs(cands) {
      for (let idx = 0; idx < cands.length; idx++) {
        if ((performance.now() - startDiffPhase) > DIFF_BUDGET_MS) {
          console.warn('[LicenseMatch][Diff] Budget exceeded; stopping.');
          break;
        }
        if (idx >= effectiveDiffCap) break;

        const cand = cands[idx];
        try {
          if (!cand.canonLicense) cand.canonLicense = canonicalizeForDiff(cand.licenseText);
          const canonLic = cand.canonLicense;

          const saved = dmp.Diff_Timeout;
          let diffChars = dmp.diff_main(canonLic, canonSelected);
          dmp.diff_cleanupSemantic(diffChars);
          let sims = computeDiffSimilarities(diffChars, canonLic.length, canonSelected.length);

          if (shouldEscalate(cand, sims) && escalationsUsed < MAX_ESCALATIONS) {
            escalationsUsed++;
            dmp.Diff_Timeout = 0.6;
            diffChars = dmp.diff_main(canonLic, canonSelected);
            dmp.diff_cleanupSemantic(diffChars);
            sims = computeDiffSimilarities(diffChars, canonLic.length, canonSelected.length);

            if (sims.containmentPct < 5 && escalationsUsed < MAX_ESCALATIONS) {
              escalationsUsed++;
              dmp.Diff_Timeout = 0;
              diffChars = dmp.diff_main(canonLic, canonSelected);
              dmp.diff_cleanupSemantic(diffChars);
              sims = computeDiffSimilarities(diffChars, canonLic.length, canonSelected.length);
            }
            dmp.Diff_Timeout = saved;
          }

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
        if (diffEvaluated % 15 === 0) {
          sendProgress({
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

    if (refined.length < Math.max(2, Math.floor(MAX_RESULTS / 2)) &&
        (performance.now() - startDiffPhase) < (DIFF_BUDGET_MS * 0.6) &&
        approxCandidates.length > toRefine.length) {

      const expansion = approxCandidates.slice(
        toRefine.length,
        Math.min(approxCandidates.length, toRefine.length + (MAX_RESULTS * 2))
      );
      if (expansion.length) {
        sendProgress({
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

    return refined.slice(0, MAX_RESULTS);
  } catch (err) {
    console.error('Error in fetchLicenses:', err);
    throw err;
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
    for (const m of ['showUI', 'clearResults']) {
      try {
        await sendMessageToTab(originTabId, { action: m });
      } catch (msgErr) {
        console.warn('Retrying message', m, 'after brief delay due to', msgErr.message);
        await new Promise(r => setTimeout(r, 100));
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
      console.log('Sending showResults with', matches.length, 'matches. Top license:', matches[0]?.license);
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
        const twoWeeksInMs = CONFIG.cache.updateIntervalMs;

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
      updateBadge("orange");

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
            if (licenseData && licenseData.text) {
              licenseData.text = normalizeLicenseText(licenseData.text);
            }

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
      updateBadge("green");

      return true;
    } catch (error) {
      console.error('Error updating license database:', error);
      updateBadge("red");

      // Reset badge after a delay
      setTimeout(() => {
        updateBadge("green");
      }, 5000);

      return false;
    }
  } else {
    console.log('License database is up to date');
    return true;
  }
}

function prepareDisplayText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ');
}

/**
 * Produce a stable pretty HTML diff between two display texts, retrying if an early timeout
 * yields a degenerate full delete + full insert result.
 */
function generateStableDisplayDiff(licenseText, selectionText) {
  const originalTimeout = dmp.Diff_Timeout;
  dmp.Diff_Timeout = Math.max(originalTimeout, 1.0); // give more time for UI diff

  const a = prepareDisplayText(licenseText);
  const b = prepareDisplayText(selectionText);

  let diff = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diff);

  const degenerate = (
    diff.length === 2 &&
    diff[0][0] === -1 &&
    diff[1][0] === 1 &&
    diff[0][1].length === a.length &&
    diff[1][1].length === b.length
  );

  if (degenerate) {
    console.warn('[LicenseMatch][DisplayDiff] Degenerate diff; retry unlimited.');
    dmp.Diff_Timeout = 0;
    diff = dmp.diff_main(a, b);
    dmp.diff_cleanupSemantic(diff);
  }

  dmp.Diff_Timeout = originalTimeout;
  return dmp.diff_prettyHtml(diff);
}

function updateBadge(color){
  switch(color) {
    case "green":
      chrome.action.setBadgeText({ text: 'Diff' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      break;
    case "red":
      chrome.action.setBadgeText({ text: 'Error' });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
      break;
    case "orange":
      chrome.action.setBadgeText({ text: 'Load' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });
      break;
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
