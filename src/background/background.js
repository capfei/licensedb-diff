// Background script entry
'use strict';
console.log('Background script loaded.');

import DiffMatchPatch from "../lib/diff_match_patch.js";
import { SCAN_DEFAULTS, SCAN_ENDPOINTS } from "../shared/scan-defaults.js";
import { UI_DEFAULTS, BADGE_STYLES, BADGE_DEFAULT } from "../shared/ui-defaults.js";

// configuration constants
const CONFIG = {
  scan: {
    maxResults: SCAN_DEFAULTS.maxResults,
    finalThresholdPct: SCAN_DEFAULTS.minSimilarityPct,
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
  }
};

function updateBadge(color) {
  const style = BADGE_STYLES[color] || BADGE_STYLES[BADGE_DEFAULT];
  chrome.action.setBadgeText({ text: style.text });
  chrome.action.setBadgeBackgroundColor({ color: style.color });
}

const FILTER_OPTIONS = Object.freeze({ LICENSES: 'licenses', EXCEPTIONS: 'exceptions', BOTH: 'both' });
const SOURCES = Object.freeze({ LICENSEDB: 'licensedb', SPDX: 'spdx' });
const SPDX_URLS = Object.freeze({
  licenses: SCAN_ENDPOINTS.spdxLicensesJson,
  exceptions: SCAN_ENDPOINTS.spdxExceptionsJson
});
let currentScanFilter = FILTER_OPTIONS.BOTH;

function normalizeFilter(value) {
  return Object.values(FILTER_OPTIONS).includes(value) ? value : FILTER_OPTIONS.BOTH;
}

currentScanFilter = normalizeFilter(UI_DEFAULTS.scanFilter);

const dmp = new DiffMatchPatch();
// In-memory cache of license term-frequency vectors (populated on demand)
let licenseVectorsCache = null; // { license_key: { word: freq, ... } }

// Track which tabs are currently running scans
const activeScans = new Set();
let scanTraceCounter = 0;

function nextScanTrace(prefix = 'scan') {
  scanTraceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${scanTraceCounter}`;
}

// Database version - increment when structure changes
const DB_VERSION = 3;
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
      if (!db.objectStoreNames.contains('spdx_entries')) {
        db.createObjectStore('spdx_entries', { keyPath: 'entry_key' });
      }
      if (!db.objectStoreNames.contains('spdx_vectors')) {
        db.createObjectStore('spdx_vectors', { keyPath: 'entry_key' });
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

function makeSpdxEntryKey(kind, id) {
  return `spdx:${kind}:${id}`;
}

function resolveSpdxDetailsUrl(detailsUrl) {
  try {
    return new URL(detailsUrl, `${SCAN_ENDPOINTS.spdxLicensesBase}/`).toString();
  } catch {
    return null;
  }
}

async function getStoreRecord(storeName, key) {
  try {
    const db = await openDatabase();
    const tx = db.transaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    return await promisifyRequest(store.get(key));
  } catch {
    return null;
  }
}

async function putStoreRecord(storeName, record) {
  const db = await openDatabase();
  const tx = db.transaction([storeName], 'readwrite');
  const store = tx.objectStore(storeName);
  return promisifyRequest(store.put(record));
}

async function getMetadataEntry(id) {
  const record = await getStoreRecord('metadata', id);
  return record?.data || null;
}

async function setMetadataEntry(id, data) {
  await putStoreRecord('metadata', { id, data });
}

async function isSpdxInitialized() {
  const record = await getStoreRecord('status', 'spdx_initialization');
  return !!(record && record.completed === true);
}

async function markSpdxInitialized(versionInfo = {}) {
  await putStoreRecord('status', {
    id: 'spdx_initialization',
    completed: true,
    timestamp: new Date().toISOString(),
    ...versionInfo
  });
}

function extractSpdxText(kind, detail) {
  const text = kind === 'exception'
    ? (detail?.licenseExceptionText || detail?.licenseText || '')
    : (detail?.licenseText || detail?.standardLicenseTemplate || '');
  return normalizeLicenseText(text || '');
}

async function fetchSpdxIndexes(noCache = false) {
  const fetchOptions = noCache ? { cache: 'no-cache' } : undefined;
  const [licensesResp, exceptionsResp] = await Promise.all([
    fetch(SPDX_URLS.licenses, fetchOptions),
    fetch(SPDX_URLS.exceptions, fetchOptions)
  ]);

  if (!licensesResp.ok) throw new Error(`Failed to fetch SPDX licenses: ${licensesResp.statusText}`);
  if (!exceptionsResp.ok) throw new Error(`Failed to fetch SPDX exceptions: ${exceptionsResp.statusText}`);

  const [licensesJson, exceptionsJson] = await Promise.all([
    licensesResp.json(),
    exceptionsResp.json()
  ]);

  const licenses = (licensesJson?.licenses || []).filter(item => !item?.isDeprecatedLicenseId);
  const exceptions = (exceptionsJson?.exceptions || []).filter(item => !item?.isDeprecatedLicenseId);

  return {
    licenses,
    exceptions,
    versionInfo: {
      licensesVersion: licensesJson?.licenseListVersion || null,
      exceptionsVersion: exceptionsJson?.licenseListVersion || null
    }
  };
}

async function syncSpdxDatabase({ noCache = false, progressStart = null, progressSpan = null } = {}) {
  const { licenses, exceptions, versionInfo } = await fetchSpdxIndexes(noCache);

  await setMetadataEntry('spdx_licenses_index', licenses);
  await setMetadataEntry('spdx_exceptions_index', exceptions);

  const entries = [
    ...licenses.map(item => ({ kind: 'license', item })),
    ...exceptions.map(item => ({ kind: 'exception', item }))
  ];

  const db = await openDatabase();
  let processed = 0;
  let failures = 0;
  const batchSize = 50;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, Math.min(i + batchSize, entries.length));
    await Promise.all(batch.map(async ({ kind, item }) => {
      const id = kind === 'exception' ? item.licenseExceptionId : item.licenseId;
      if (!id) return;

      try {
        const detailsUrl = resolveSpdxDetailsUrl(item.detailsUrl);
        if (!detailsUrl) throw new Error(`Invalid details URL for SPDX ${kind}: ${id}`);

        const detailResp = await fetch(detailsUrl, noCache ? { cache: 'no-cache' } : undefined);
        if (!detailResp.ok) throw new Error(`Failed to fetch SPDX ${kind} detail ${id}: ${detailResp.statusText}`);
        const detailJson = await detailResp.json();

        const text = extractSpdxText(kind, detailJson);
        const entryKey = makeSpdxEntryKey(kind, id);
        const data = {
          source: SOURCES.SPDX,
          kind,
          id,
          spdx: id,
          name: item.name || detailJson?.name || id,
          text,
          detailsUrl,
          reference: item.reference || detailJson?.reference || null,
          seeAlso: item.seeAlso || detailJson?.seeAlso || []
        };

        const entryStore = db.transaction(['spdx_entries'], 'readwrite').objectStore('spdx_entries');
        await promisifyRequest(entryStore.put({ entry_key: entryKey, data }));

        if (text) {
          const vector = createTextVector(text);
          const vectorStore = db.transaction(['spdx_vectors'], 'readwrite').objectStore('spdx_vectors');
          await promisifyRequest(vectorStore.put({ entry_key: entryKey, data: vector }));
          licenseVectorsCache = null;
          docFreqCache = null;
        }
      } catch (error) {
        failures++;
        console.error(`Error processing SPDX ${kind} ${id}:`, error);
      }
    }));

    processed += batch.length;
    if (progressStart !== null && progressSpan !== null) {
      const pct = Math.round(progressStart + (processed / entries.length) * progressSpan);
      sendProgressUpdate(pct, `Processing SPDX entries: ${processed}/${entries.length} (${failures} failures)`);
      chrome.action.setBadgeText({ text: `${Math.min(99, pct)}%` });
    }
  }

  await cacheSpdxListVersion(versionInfo);
  await markSpdxInitialized(versionInfo);

  console.log(`SPDX sync complete. Processed ${processed} entries with ${failures} failures.`);
}

async function ensureSpdxDataInitialized() {
  const initialized = await isSpdxInitialized();
  if (initialized) return true;

  console.log('SPDX data not initialized. Starting sync...');
  await syncSpdxDatabase({ noCache: false });
  return true;
}

async function preloadLicenseDatabase() {
  try {
    // Check if already initialized
    const isInitialized = await isDatabaseInitialized();
    if (isInitialized) {
      console.log('License database already initialized');
      await ensureSpdxDataInitialized();
      return true;
    }

    console.log('Starting license database initialization...');
    updateBadge('orange');

    // First, fetch the license index
    const licenseList = await fetch(SCAN_ENDPOINTS.scancodeIndexJson)
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
          const licenseUrl = `${SCAN_ENDPOINTS.scancodeBase}/${license.json}`;
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

    // Load SPDX licenses/exceptions as part of initial bootstrap
    await syncSpdxDatabase({ noCache: false });

    // Record the update timestamp when initializing
    await recordUpdateTimestamp();

    // Reset badge
    updateBadge('green');

    console.log(`License database initialization completed. Processed ${processed} licenses with ${failures} failures.`);
    return true;
  } catch (error) {
    console.error('Error initializing license database:', error);
    updateBadge('red');
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
              chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] }).catch(() => { }),
              chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] })
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
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] }).catch(() => { });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
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
    .trim()
}

// Prepare text for visual diff display
function prepareDisplayText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ');
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

function tokenizeNormalizedText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function tokenLevenshteinDistance(tokensA, tokensB) {
  const aLen = tokensA.length;
  const bLen = tokensB.length;
  if (!aLen) return bLen;
  if (!bLen) return aLen;

  let previous = new Array(bLen + 1);
  let current = new Array(bLen + 1);

  for (let j = 0; j <= bLen; j++) previous[j] = j;

  for (let i = 1; i <= aLen; i++) {
    current[0] = i;
    const aToken = tokensA[i - 1];
    for (let j = 1; j <= bLen; j++) {
      const bToken = tokensB[j - 1];
      const cost = aToken === bToken ? 0 : 1;
      const del = previous[j] + 1;
      const ins = current[j - 1] + 1;
      const sub = previous[j - 1] + cost;
      current[j] = Math.min(del, ins, sub);
    }
    [previous, current] = [current, previous];
  }

  return previous[bLen];
}

function tokenLevenshteinSimilarityPct(tokensA, tokensB) {
  const maxLen = Math.max(tokensA.length, tokensB.length) || 1;
  const distance = tokenLevenshteinDistance(tokensA, tokensB);
  return (1 - (distance / maxLen)) * 100;
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

function estimateTextLengthFromVector(vector) {
  if (!vector || typeof vector !== 'object') return 0;
  let words = 0;
  let chars = 0;
  for (const term in vector) {
    const freq = Number(vector[term]) || 0;
    if (!freq) continue;
    words += freq;
    chars += term.length * freq;
  }
  const spaces = Math.max(0, words - 1);
  return chars + spaces;
}

// Load all stored vectors once (or as many as available). Missing vectors can be generated lazily.
async function loadAllVectors() {
  if (licenseVectorsCache) return licenseVectorsCache;
  licenseVectorsCache = {};
  try {
    const db = await openDatabase();
    const loadStoreVectors = (storeName) => new Promise((resolve) => {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.openCursor();
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const key = cursor.key;
          licenseVectorsCache[key] = cursor.value.data;
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => resolve();
    });

    await loadStoreVectors('vectors');
    if (db.objectStoreNames.contains('spdx_vectors')) {
      await loadStoreVectors('spdx_vectors');
    }
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
    scanFilter: normalizeFilter(UI_DEFAULTS.scanFilter)
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

async function getCombinedScanIndex(scanFilter) {
  const licenseDbIndex = await fetchWithCache(
    SCAN_ENDPOINTS.scancodeIndexJson,
    'index',
    'metadata'
  );

  let spdxLicenses = await getMetadataEntry('spdx_licenses_index');
  let spdxExceptions = await getMetadataEntry('spdx_exceptions_index');

  if (!Array.isArray(spdxLicenses) || !Array.isArray(spdxExceptions)) {
    await ensureSpdxDataInitialized().catch(err => console.warn('SPDX init during scan failed:', err));
    spdxLicenses = await getMetadataEntry('spdx_licenses_index');
    spdxExceptions = await getMetadataEntry('spdx_exceptions_index');
  }

  const fromLicenseDb = (Array.isArray(licenseDbIndex) ? licenseDbIndex : [])
    .filter(l => !l?.is_deprecated)
    .filter(l => {
      if (scanFilter === FILTER_OPTIONS.LICENSES) return !l.is_exception;
      if (scanFilter === FILTER_OPTIONS.EXCEPTIONS) return l.is_exception === true;
      return true;
    })
    .map(l => ({
      source: SOURCES.LICENSEDB,
      key: l.license_key,
      storeKey: l.license_key,
      isException: !!l.is_exception,
      spdx: l.spdx_license_key || l.license_key,
      detailUrl: `${SCAN_ENDPOINTS.scancodeBase}/${l.json}`,
      raw: l
    }));

  const fromSpdxLicenses = (Array.isArray(spdxLicenses) ? spdxLicenses : [])
    .filter(l => !l?.isDeprecatedLicenseId)
    .filter(() => scanFilter !== FILTER_OPTIONS.EXCEPTIONS)
    .map(l => {
      const id = l.licenseId;
      return {
        source: SOURCES.SPDX,
        key: id,
        storeKey: makeSpdxEntryKey('license', id),
        isException: false,
        spdx: id,
        detailUrl: resolveSpdxDetailsUrl(l.detailsUrl),
        raw: l
      };
    });

  const fromSpdxExceptions = (Array.isArray(spdxExceptions) ? spdxExceptions : [])
    .filter(e => !e?.isDeprecatedLicenseId)
    .filter(() => scanFilter !== FILTER_OPTIONS.LICENSES)
    .map(e => {
      const id = e.licenseExceptionId;
      return {
        source: SOURCES.SPDX,
        key: id,
        storeKey: makeSpdxEntryKey('exception', id),
        isException: true,
        spdx: id,
        detailUrl: resolveSpdxDetailsUrl(e.detailsUrl),
        raw: e
      };
    });

  return [...fromLicenseDb, ...fromSpdxLicenses, ...fromSpdxExceptions].filter(item => item.key);
}

async function loadScanEntryData(entry) {
  if (entry.source === SOURCES.LICENSEDB) {
    const data = await fetchWithCache(entry.detailUrl, entry.storeKey, 'licenses').catch(() => null);
    if (!data) return null;
    if (data.text) data.text = normalizeLicenseText(data.text);
    return {
      key: entry.storeKey,
      license: entry.key,
      name: data.name || entry.key,
      spdx: entry.spdx || entry.key,
      text: data.text || ''
    };
  }

  const existing = await getStoreRecord('spdx_entries', entry.storeKey);
  if (existing?.data?.text) {
    return {
      key: entry.storeKey,
      license: entry.key,
      name: existing.data.name || entry.key,
      spdx: existing.data.spdx || entry.key,
      text: normalizeLicenseText(existing.data.text)
    };
  }

  const detailsUrl = entry.detailUrl;
  if (!detailsUrl) return null;
  const response = await fetch(detailsUrl);
  if (!response.ok) return null;
  const detailJson = await response.json();
  const text = extractSpdxText(entry.isException ? 'exception' : 'license', detailJson);
  const data = {
    source: SOURCES.SPDX,
    kind: entry.isException ? 'exception' : 'license',
    id: entry.key,
    spdx: entry.spdx || entry.key,
    name: entry.raw?.name || detailJson?.name || entry.key,
    text,
    detailsUrl
  };
  await putStoreRecord('spdx_entries', { entry_key: entry.storeKey, data });
  if (text) {
    const vector = createTextVector(text);
    await putStoreRecord('spdx_vectors', { entry_key: entry.storeKey, data: vector });
    licenseVectorsCache = null;
    docFreqCache = null;
  }

  return {
    key: entry.storeKey,
    license: entry.key,
    name: data.name,
    spdx: data.spdx,
    text
  };
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
    const combinedIndex = await getCombinedScanIndex(scanFilter);
    if (!combinedIndex.length) {
      console.warn('[LicenseMatch] No entries match filter', scanFilter);
      return [];
    }
    const licenses = combinedIndex;

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
    const selectedTokens = tokenizeNormalizedText(selectedNormalized);
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
          let licenseVector = licenseVectorsCache[lic.storeKey];
          if (!licenseVector) {
            const licData = await loadScanEntryData(lic).catch(() => null);
            if (!licData || !licData.text) return null;
            const licenseTextNorm = normalizeLicenseText(licData.text);
            licenseVector = createTextVector(licenseTextNorm);
            licenseVectorsCache[lic.storeKey] = licenseVector;
          }

          const estimatedLicenseLen = estimateTextLengthFromVector(licenseVector);

        // Quick structural filter
        if (!quickSimilarityCheck(textVector, licenseVector)) {
          quickFail++;
          return null;
        }
        quickPass++;

        // Approx char similarity (%)
        const approxPct = approximateCharSimilarity(
          textVector, licenseVector, wordLenCache,
          selectedLength, estimatedLicenseLen || selectedLength
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
          let licShingles = licenseShingleCache[lic.storeKey];
          if (!licShingles) {
            licShingles = buildShingles(licWords, 5);
            licenseShingleCache[lic.storeKey] = licShingles;
          }
          if (licShingles.size) shingleJac = jaccard(selShingles, licShingles);
        }

        // Keep the approximate phase vector-only; defer full text loading to diff stage.
        const segSimPct = 0;

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
          entry: lic,
          license: lic.key,
          spdx: lic.spdx || lic.key,
          source: lic.source,
          cacheKey: lic.storeKey,
          approxSimilarity: combined,
          rawApprox: approxPct,
          overlapCoeff: overlapCoeffVal,
          cosine: cosineVal,
          shingleJac,
          segSimPct
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
      console.info(`[LicenseMatch] Fallback (<5 candidates).`);
      const textTokenSet = new Set(selWords);
      const overlapScores = [];
      for (const lic of licenses) {
        try {
          const vec = licenseVectorsCache[lic.storeKey];
          if (!vec) continue;
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
          approxCandidates.push({
            entry: s.lic,
            license: s.lic.key,
            spdx: s.lic.spdx || s.lic.key,
            source: s.lic.source,
            cacheKey: s.lic.storeKey,
            approxSimilarity: s.overlapCoeffVal * 100,
            overlapCoeff: s.overlapCoeffVal
          });
        } catch { /* ignore */ }
      }
      console.info(`[LicenseMatch] Fallback expanded candidates to ${approxCandidates.length}.`);
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

    const DIFF_BUDGET_MS = selectedLength > 20000 ? 8000 :
                         selectedLength > 10000 ? 5000 :
                         selectedLength > 6000  ? 4000 :
                         selectedLength > 3000  ? 3500 : 3200;

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
          console.info('[LicenseMatch][Diff] Budget exceeded; stopping.');
          budgetExceeded = true;
          break;
        }
        if (idx >= effectiveDiffCap) break;

        const cand = cands[idx];
        try {
          if (!cand.licenseText) {
            const hydrated = await loadScanEntryData(cand.entry).catch(() => null);
            if (!hydrated || !hydrated.text) {
              continue;
            }
            cand.licenseText = normalizeLicenseText(hydrated.text);
            cand.license = hydrated.license;
            cand.name = hydrated.name;
            cand.spdx = hydrated.spdx;
            cand.cacheKey = hydrated.key;
          }

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

          // Token-level scoring: faster and more meaningful than character-level
          const licenseTokens = tokenizeNormalizedText(cand.licenseText);
          const tokenLevPct = tokenLevenshteinSimilarityPct(selectedTokens, licenseTokens);
          const containmentTokenPct = Math.max(0, Math.min(100, (cand.overlapCoeff || 0) * 100));
          const cosineTokenPct = Math.max(
            0,
            Math.min(
              100,
              ((cand.cosine ?? cosine(textVector, licenseVectorsCache[cand.cacheKey] || {})) || 0) * 100
            )
          );

          const finalScore =
            0.40 * containmentTokenPct +
            0.35 * cosineTokenPct +
            0.25 * tokenLevPct;

          const passes =
            containmentTokenPct >= FINAL_THRESHOLD ||
            finalScore >= FINAL_THRESHOLD;

          if (passes) {
            refined.push({
              license: cand.license,
              name: cand.name,
              spdx: cand.spdx,
              source: cand.source || SOURCES.LICENSEDB,
              charSimilarity: finalScore.toFixed(2),
              diff: null,
              _licenseText: cand.licenseText,
              diffMetrics: {
                containment: containmentTokenPct.toFixed(2),
                cosine: cosineTokenPct.toFixed(2),
                tokenLevenshtein: tokenLevPct.toFixed(2),
                avg: sims.avgPct.toFixed(2),
                jaccard: sims.jaccardPct.toFixed(2)
              },
              score: finalScore.toFixed(2),
              link: (cand.source === SOURCES.SPDX)
                ? `${SCAN_ENDPOINTS.spdxLicensesBase}/${cand.license}.html`
                : `${SCAN_ENDPOINTS.scancodeBase}/${cand.license}.html`
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

    // Deferred display-diff generation: render diffs for the final results
    // after scoring is complete, so slow diffs don't eat into the scoring budget.
    const finalResults = refined.slice(0, MAX_RESULTS);
    const DISPLAY_DIFF_BUDGET_MS = selectedLength > 20000 ? 30000 : 15000;
    const displayDiffStart = performance.now();
    for (let di = 0; di < finalResults.length; di++) {
      const result = finalResults[di];
      if (result.diff !== null || !result._licenseText) continue;
      const elapsed = performance.now() - displayDiffStart;
      if (elapsed > DISPLAY_DIFF_BUDGET_MS) {
        console.warn(`[LicenseMatch][DisplayDiff] Budget exhausted after ${di} diffs (${elapsed.toFixed(0)}ms)`);
        break;
      }
      try {
        result.diff = generateStableDisplayDiff(result._licenseText, originalSelected);
      } catch {
        result.diff = '(diff error)';
      }
      delete result._licenseText;
      if (di % 3 === 2) await new Promise(r => setTimeout(r, 0));
    }
    // Second pass: generate display diffs for any remaining results
    // that didn't get processed in the first pass (budget exhaustion).
    const remaining = finalResults.filter(r => r.diff === null && r._licenseText);
    if (remaining.length) {
      console.info(`[LicenseMatch][DisplayDiff] Second pass for ${remaining.length} remaining results`);
      for (const result of remaining) {
        try {
          result.diff = generateStableDisplayDiff(result._licenseText, originalSelected);
        } catch {
          result.diff = '(diff error)';
        }
        delete result._licenseText;
        await new Promise(r => setTimeout(r, 0));
      }
    }
    for (const result of finalResults) {
      if (result.diff === null) {
        result.diff = '(diff unavailable)';
      }
      delete result._licenseText;
    }

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
async function processLicenseCheck(tabId, selectedText, scanFilter = FILTER_OPTIONS.BOTH, traceId = nextScanTrace('scan')) {
  const startedAt = performance.now();
  console.info(`[LicenseMatch][${traceId}] processLicenseCheck begin`, {
    tabId,
    filter: scanFilter,
    textLength: selectedText?.length || 0
  });

  if (!tabId) {
    console.error(`[LicenseMatch][${traceId}] processLicenseCheck called without a tab ID.`);
    return;
  }

  if (!selectedText || selectedText.trim().length === 0) {
    showNotification(tabId, 'Please select some text to compare with licenses.', 'warning');
    return;
  }

  if (activeScans.has(tabId)) {
    console.info(`[LicenseMatch][${traceId}] Tab ${tabId} already scanning; allowing new scan to queue.`);
    activeScans.delete(tabId);
  }

  // Mark this tab as having an active scan
  activeScans.add(tabId);

  try {
    // Make sure content script is available
    const ready = await ensureContentScript(tabId);
    if (!ready) {
      console.error(`[LicenseMatch][${traceId}] Content script not available after injection attempts.`);
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
      console.info(`[LicenseMatch][${traceId}] sending showResults`, {
        matches: matches.length,
        top: matches[0]?.license
      });
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
    console.error(`[LicenseMatch][${traceId}] Error processing license check:`, error);
    try {
      await sendMessageToTab(tabId, {
        action: 'showError',
        error: error.message || 'An unknown error occurred'
      });
    } catch (err) {
      console.error('Error showing error notification:', err);
    }
  } finally {
    const durationMs = (performance.now() - startedAt).toFixed(1);
    console.info(`[LicenseMatch][${traceId}] processLicenseCheck end`, { tabId, durationMs });
    // Remove this tab from active scans
    activeScans.delete(tabId);
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
    const traceId = nextScanTrace('msg');
    console.info(`[LicenseMatch][${traceId}] checkLicense received`, {
      hasSenderTab: !!sender?.tab?.id,
      textLength: selectedText?.length || 0,
      filter: scanFilter
    });

    const startProcessing = (tabId) => {
      console.info(`[LicenseMatch][${traceId}] starting processLicenseCheck`, { tabId, filter: scanFilter });
      processLicenseCheck(tabId, selectedText, scanFilter, traceId)
        .catch((error) => {
          console.error(`[LicenseMatch][${traceId}] processLicenseCheck failed:`, error);
        });
    };

    // Store the tab ID that initiated the request
    const senderTabId = sender.tab ? sender.tab.id : null;

    // Acknowledge immediately; scanning progress/results are delivered separately
    // via tab messages and do not require keeping this response channel open.
    sendResponse({ status: 'started' });

    if (!senderTabId) {
      // If no tab ID is available (e.g., sent from popup), get the current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No active tabs found';
          console.error('Error getting active tab:', errMsg);
          return;
        }

        startProcessing(tabs[0].id);
      });
    } else {
      startProcessing(senderTabId);
    }

    return false;
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
    const traceId = nextScanTrace('popup');
    currentScanFilter = chosenFilter;
    console.info(`[LicenseMatch][${traceId}] startScanWithFilter received`, { filter: chosenFilter });

    (async () => {
      try {
        await new Promise((resolve) => {
          try {
            chrome.storage?.sync?.set({ scanFilter: chosenFilter }, () => resolve(true));
          } catch {
            resolve(true);
          }
        });

        await initiateScanForActiveTab(chosenFilter, traceId);
        console.info(`[LicenseMatch][${traceId}] scan initiation requested`);
        sendResponse({ started: true });
      } catch (error) {
        console.error(`[LicenseMatch][${traceId}] startScanWithFilter failed:`, error);
        sendResponse({ started: false, error: error?.message || 'Failed to start scan' });
      }
    })();

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
      const licenseDbCount = await new Promise((resolve) => {
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => resolve(0);
      });

      let spdxCount = 0;
      if (db.objectStoreNames.contains('spdx_entries')) {
        const spdxTx = db.transaction(['spdx_entries'], 'readonly');
        const spdxStore = spdxTx.objectStore('spdx_entries');
        const spdxCountRequest = spdxStore.count();
        spdxCount = await new Promise((resolve) => {
          spdxCountRequest.onsuccess = () => resolve(spdxCountRequest.result);
          spdxCountRequest.onerror = () => resolve(0);
        });
      }

      licenseCount = licenseDbCount + spdxCount;
    } catch (error) {
      console.error('Error getting license count:', error);
    }

    // Get license list versions
    let licenseDbVersion = await getLicenseDbVersion();
    let spdxListVersion = await getSpdxListVersion();

    return {
      isInitialized,
      lastUpdate,
      licenseCount,
      licenseDbVersion,
      spdxListVersion
    };
  } catch (error) {
    console.error('Error getting database info:', error);
    throw error;
  }
}

// Function to get LicenseDB list version
async function getLicenseDbVersion() {
  try {
    const cached = await getCachedLicenseDbVersion();
    if (cached && cached.timestamp) {
      const ageMs = Date.now() - new Date(cached.timestamp).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return cached.version || null; // cache < 1 day
    }
    // Preferred: parse the user-facing footer text from index.html,
    // e.g. "Generated with ScanCode toolkit 32.5.0 on 2026-01-22."
    try {
      const htmlResp = await fetch(SCAN_ENDPOINTS.scancodeIndexHtml, { cache: 'no-cache' });
      if (htmlResp.ok) {
        const html = await htmlResp.text();
        const match = html.match(/Generated\s+with\s+ScanCode\s+toolkit\s+([0-9]+(?:\.[0-9]+)*)\s+on\s+(\d{4}-\d{2}-\d{2})/i);
        if (match) {
          const toolkitVersion = match[1];
          const generatedDate = match[2];
          const version = `ScanCode toolkit ${toolkitVersion} (${generatedDate})`;
          await cacheLicenseDbVersion(version);
          return version;
        }
      }
    } catch (footerErr) {
      console.warn('Could not parse ScanCode footer version:', footerErr?.message || footerErr);
    }

    // Fallback: derive a pseudo version from index.json content fingerprint
    const resp = await fetch(SCAN_ENDPOINTS.scancodeIndexJson, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Failed to fetch license index for version');
    const text = await resp.text();
    let hash = 0; for (let i = 0; i < text.length; i++) { hash = (hash * 31 + text.charCodeAt(i)) >>> 0; }
    const fallbackVersion = `idx-${hash}-${text.length}`;
    await cacheLicenseDbVersion(fallbackVersion);
    return fallbackVersion;
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

// Function to get SPDX list version
async function getSpdxListVersion() {
  try {
    const cached = await getCachedSpdxListVersion();
    if (cached?.timestamp) {
      const ageMs = Date.now() - new Date(cached.timestamp).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return cached.version || null;
    }

    const { versionInfo } = await fetchSpdxIndexes(true);
    await cacheSpdxListVersion(versionInfo);
    const licensesVersion = versionInfo?.licensesVersion || null;
    const exceptionsVersion = versionInfo?.exceptionsVersion || null;
    if (licensesVersion && exceptionsVersion && licensesVersion !== exceptionsVersion) {
      return `licenses:${licensesVersion} / exceptions:${exceptionsVersion}`;
    }
    return licensesVersion || exceptionsVersion || null;
  } catch (e) {
    console.warn('Could not determine SPDX list version:', e.message || e);
    return null;
  }
}

// Get the cached SPDX list version
async function getCachedSpdxListVersion() {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readonly');
    const store = tx.objectStore('status');
    try {
      return await promisifyRequest(store.get('spdx_list_version'));
    } catch {
      return null;
    }
  } catch (error) {
    console.error('Error getting cached SPDX list version:', error);
    return null;
  }
}

async function cacheSpdxListVersion(versionInfo) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(['status'], 'readwrite');
    const store = tx.objectStore('status');
    const licensesVersion = versionInfo?.licensesVersion || null;
    const exceptionsVersion = versionInfo?.exceptionsVersion || null;
    const combined = licensesVersion && exceptionsVersion && licensesVersion !== exceptionsVersion
      ? `licenses:${licensesVersion} / exceptions:${exceptionsVersion}`
      : (licensesVersion || exceptionsVersion || null);
    await promisifyRequest(store.put({
      id: 'spdx_list_version',
      version: combined,
      licensesVersion,
      exceptionsVersion,
      timestamp: new Date().toISOString()
    }));
  } catch (e) {
    // non-fatal
  }
}

// Force update the database (manual trigger from options page)
async function forceUpdateDatabase() {
  try {
    // Set badge to indicate update in progress
    updateBadge('orange');

    // Send initial progress to options page
    sendProgressUpdate(0, 'Starting database update...');

    // Fetch the license index to check for changes
    sendProgressUpdate(5, 'Fetching license index...');
    const response = await fetch(SCAN_ENDPOINTS.scancodeIndexJson, {
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
          const licenseUrl = `${SCAN_ENDPOINTS.scancodeBase}/${license.json}`;
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

    // Update SPDX data as part of refresh
    sendProgressUpdate(92, 'Updating SPDX lists...');
    await syncSpdxDatabase({ noCache: true, progressStart: 92, progressSpan: 6 });

    // Record the update timestamp
    sendProgressUpdate(98, 'Finalizing update...');
    await recordUpdateTimestamp();

    // Set flag to indicate database is initialized
    await markDatabaseInitialized();

    // Also update the license list versions when forcing an update
    await getLicenseDbVersion();
    await getSpdxListVersion();

    // Final success
    sendProgressUpdate(100, 'Database update complete', true);

    console.log(`License database update completed. Processed ${processed} licenses with ${failures} failures.`);

    // Reset badge
    updateBadge('green');

    return true;
  } catch (error) {
    console.error('Error updating database:', error);

    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);

    // Error badge and then reset
    updateBadge('red');

    setTimeout(() => {
      updateBadge('green');
    }, 5000);

    throw error;
  }
}

// Reset database (completely delete and reinitialize)
async function resetDatabase() {
  try {
    // Set badge to indicate reset in progress
    updateBadge('orange');

    // Send initial progress to options page
    sendProgressUpdate(0, 'Deleting database...');

    // Close any open handles from this service worker before deletion.
    // If a connection is left open, deleteDatabase can remain blocked.
    try {
      if (dbInstance) {
        dbInstance.close();
      }
    } catch (closeErr) {
      console.warn('Error while closing existing DB connection before reset:', closeErr);
    } finally {
      dbInstance = null;
      dbOpenPromise = null;
    }

    // Delete the database
    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase('LicenseDB');
      deleteRequest.onsuccess = () => {
        console.log('Database deleted successfully');
        resolve();
      };
      deleteRequest.onblocked = () => {
        const error = new Error('Failed to delete database: deletion is blocked by another open tab or extension context.');
        console.error(error);
        reject(error);
      };
      deleteRequest.onerror = () => {
        const reason = deleteRequest.error?.message || 'unknown error';
        const error = new Error(`Failed to delete database: ${reason}`);
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
    updateBadge('green');

    return true;
  } catch (error) {
    console.error('Error resetting database:', error);

    // Send error progress update
    sendProgressUpdate(0, `Error: ${error.message || 'Unknown error'}`, true);

    // Reset badge
    updateBadge('red');

    setTimeout(() => {
      updateBadge('green');
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
  const traceId = nextScanTrace('action');
  console.info(`[LicenseMatch][${traceId}] action icon clicked`, { tabId: tab?.id, filter: currentScanFilter });
  await handleActionClick(tab, currentScanFilter, traceId);
});

async function initiateScanForActiveTab(filterChoice, traceId = nextScanTrace('start')) {
  try {
    console.info(`[LicenseMatch][${traceId}] resolving active tab`, { filter: filterChoice });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      console.info(`[LicenseMatch][${traceId}] active tab resolved`, { tabId: tab.id, url: tab.url || '' });
      await handleActionClick(tab, filterChoice, traceId);
    } else {
      console.warn(`[LicenseMatch][${traceId}] No active tab for scan.`);
    }
  } catch (err) {
    console.error(`[LicenseMatch][${traceId}] initiateScanForActiveTab failed:`, err);
  }
}

async function handleActionClick(tab, filterChoice, traceId = nextScanTrace('handle')) {
  try {
    console.info(`[LicenseMatch][${traceId}] handleActionClick begin`, { tabId: tab?.id, filter: filterChoice });
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('edge://')) {
      console.warn(`[LicenseMatch][${traceId}] Cannot run on this page type:`, url);
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
      console.info(`[LicenseMatch][${traceId}] no selected text found in frames`);
      showNotification(tab.id, 'Please select text before running license check.', 'warning');
      return;
    }
    const best = candidates.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    console.info(`[LicenseMatch][${traceId}] selection captured`, {
      candidates: candidates.length,
      selectedLength: best.text.length,
      inIframe: !!best.inIframe,
      frameUrl: best.frameUrl || ''
    });

    // Send single message to existing handler (adds iframe metadata for future use)
    // Directly initiate processing instead of round-trip messaging
    sendMessageToTab(tab.id, { action: 'showUI' })
      .catch(() => Promise.resolve())
      .finally(() => {
        processLicenseCheck(tab.id, best.text, filterChoice, traceId);
      });
  } catch (err) {
    console.error(`[LicenseMatch][${traceId}] Selection collection error:`, err);
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
    } else {
      await ensureSpdxDataInitialized();
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
    updateBadge('green');
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

  const normalizeForParagraphDiff = (value) => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/([^\n])[ \t]*\n[ \t]*(?=[^\n])/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paraA = normalizeForParagraphDiff(displayA);
  const paraB = normalizeForParagraphDiff(displayB);

  // Keep canonical only for "do we have overlap" checks; do NOT use it as a display-diff source.
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

  const evaluateDiffQuality = (diff) => {
    if (!Array.isArray(diff) || !diff.length) return -Infinity;
    let equalChars = 0;
    let replacementPairs = 0;
    let largeReplacementPairs = 0;

    const toTuple = (entry) => {
      if (!entry) return null;
      if (Array.isArray(entry)) return [entry[0], String(entry[1] ?? '')];
      if (typeof entry === 'object') {
        const op = entry.op ?? entry.operation ?? entry.type ?? entry[0];
        const data = entry.text ?? entry.data ?? entry[1];
        if (op === undefined) return null;
        return [op, String(data ?? '')];
      }
      return null;
    };

    for (let i = 0; i < diff.length; i++) {
      const current = toTuple(diff[i]);
      if (!current) continue;
      const [op, data] = current;
      if (op === 0) equalChars += data.length;

      const next = toTuple(diff[i + 1]);
      if (!next) continue;
      const [nextOp, nextData] = next;
      const isReplacement =
        (op === -1 && nextOp === 1) ||
        (op === 1 && nextOp === -1);
      if (!isReplacement) continue;
      replacementPairs++;
      if ((data.length + nextData.length) > 300) largeReplacementPairs++;
    }

    return equalChars - (replacementPairs * 120) - (largeReplacementPairs * 280);
  };

  const attemptDiff = () => {
    // For long texts, line-level diffs via diff_linesToChars_ reduce text
    // to ~500 chars, so timeout=0 is safe. If line-level produces degenerate
    // results (mismatched line wrapping), fall back to char-level on
    // paragraph-normalized text with bounded timeout.
    const isLongText = (paraA.length > 15000 || paraB.length > 15000);
    const timeouts = isLongText
      ? [1, 3, 0]
      : [Math.max(originalTimeout || 0, 1), 4, 0];
    const attempts = isLongText
      ? [
          { a: paraA, b: paraB, mode: 'lines' },
          { a: displayA, b: displayB, mode: 'lines' },
          { a: canonA, b: canonB, mode: 'lines' },
          { a: paraA, b: paraB, mode: 'chars' },
        ]
      : [
          { a: paraA, b: paraB, mode: 'chars' },
          { a: paraA, b: paraB, mode: 'lines' },
          { a: displayA, b: displayB, mode: 'chars' },
          { a: displayA, b: displayB, mode: 'lines' },
          { a: canonA, b: canonB, mode: 'chars' },
          { a: canonA, b: canonB, mode: 'lines' }
        ];

    let best = null;
    let bestScore = -Infinity;
    let fallback = null;
    let fallbackScore = -Infinity;

    for (const { a, b, mode } of attempts) {
      for (const timeout of timeouts) {
        // For long-text char-level, cap timeout at 3s to prevent runaway diff
        const effectiveTimeout = (isLongText && mode === 'chars')
          ? Math.min(timeout || 3, 3)
          : timeout;
        try {
          const diff = runDisplayDiff(a, b, effectiveTimeout, mode);
          const degenerate = isDegenerate(diff, a.length, b.length);
          const hasEq = hasEqual(diff);
          const meaningful = !degenerate && hasEq && hasMeaningfulOverlap(diff, a.length, b.length);

          // Track best fallback (only requires some equal text)
          if (!degenerate && hasEq) {
            const score = evaluateDiffQuality(diff);
            if (score > fallbackScore) {
              fallback = diff;
              fallbackScore = score;
            }
          }

          if (!meaningful) continue;

          const score = evaluateDiffQuality(diff);
          if (score > bestScore) {
            best = diff;
            bestScore = score;
          }
        } catch (err) {
          console.warn(`[LicenseMatch][DisplayDiff] mode=${mode} timeout=${timeout} failed`, err);
        }
      }
    }

    if (best) return best;
    if (fallback) {
      console.info('[LicenseMatch][DisplayDiff] Using fallback diff (did not pass strict quality checks)');
      return fallback;
    }

    // Last resort: simple line-level diff with no quality gates
    try {
      const lastResort = runDisplayDiff(paraA, paraB, 0, 'lines');
      if (hasEqual(lastResort)) {
        console.info('[LicenseMatch][DisplayDiff] Using last-resort line diff');
        return lastResort;
      }
    } catch { /* ignore */ }

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
    dmp.diff_cleanupEfficiency(diff);
    diff = collapseWhitespaceOnlyReplacements(diff);
    return diff;
  } finally {
    dmp.Diff_Timeout = previous;
  }
}

function collapseWhitespaceOnlyReplacements(diff) {
  if (!Array.isArray(diff) || diff.length < 2) return diff;

  const normalizeEntry = (entry) => {
    if (!entry) return null;
    if (Array.isArray(entry)) return { op: entry[0], data: String(entry[1] ?? '') };
    if (typeof entry === 'object') {
      const op = entry.op ?? entry.operation ?? entry.type ?? entry[0];
      const data = entry.text ?? entry.data ?? entry[1];
      if (op === undefined) return null;
      return { op, data: String(data ?? '') };
    }
    return null;
  };

  const normalizeWs = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const output = [];

  for (let i = 0; i < diff.length; i++) {
    const current = normalizeEntry(diff[i]);
    if (!current) continue;
    const { op, data = '' } = current;
    const next = normalizeEntry(diff[i + 1]);

    if (next) {
      const { op: nextOp, data: nextData = '' } = next;
      const replacementPair =
        (op === -1 && nextOp === 1) ||
        (op === 1 && nextOp === -1);

      if (replacementPair && normalizeWs(data) === normalizeWs(nextData)) {
        const baseline = op === -1 ? data : nextData;
        output.push([0, baseline]);
        i++;
        continue;
      }
    }

    output.push([op, data]);
  }

  return output;
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
    .replace(/\t/g, '    ');

  const formatDiffText = (text) => escapeHtmlFragment(text);

  const renderBody = (op, chunk) => {
    const formatted = formatDiffText(chunk ?? '');
    if (op === 1) return `<ins>${formatted}</ins>`;
    if (op === -1) return `<del>${formatted}</del>`;
    return `<span>${formatted}</span>`;
  };

  const html = sanitized.map(([op, data]) => renderBody(op, data)).join('');
  return `<pre class="ldiff-output" id="outputdiv">${html}</pre>`;
}