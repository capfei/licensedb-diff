import { SCAN_DEFAULTS } from "../../shared/scan-defaults.js";
import { UI_DEFAULTS } from "../../shared/ui-defaults.js";
import ext from "../../shared/ext-api.js";

document.addEventListener('DOMContentLoaded', async function() {
  // Initialize UI
  await loadDatabaseInfo();

  // Load settings UI
  await loadUserSettingsToForm();
  await loadThemeToForm();

  // Set up button event listeners
  document.getElementById('refresh-db').addEventListener('click', refreshDatabase);
  document.getElementById('reset-db').addEventListener('click', resetDatabase);
  document.getElementById('save-settings').addEventListener('click', saveUserSettingsFromForm);
  document.getElementById('save-theme')?.addEventListener('click', saveThemeFromForm);
});

// Defaults loaded from background CONFIG (single source of truth)
let DEFAULT_SETTINGS = {
  maxResults: SCAN_DEFAULTS.maxResults,
  minSimilarityPct: SCAN_DEFAULTS.minSimilarityPct,
  maxResultsMin: SCAN_DEFAULTS.maxResultsMin,
  maxResultsMax: SCAN_DEFAULTS.maxResultsMax,
  minSimilarityMin: SCAN_DEFAULTS.minSimilarityMin,
  minSimilarityMax: SCAN_DEFAULTS.minSimilarityMax
};
const DEFAULT_APPEARANCE = { theme: UI_DEFAULTS.theme };

function storageGet(keysWithDefaults) {
  return new Promise((resolve) => {
    try {
      ext.storage.sync.get(keysWithDefaults, (items) => resolve(items || keysWithDefaults));
    } catch {
      resolve(keysWithDefaults);
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      ext.storage.sync.set(obj, () => {
        if (ext.runtime.lastError) {
          reject(new Error(ext.runtime.lastError.message));
        } else {
          resolve(true);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function loadUserSettingsToForm() {
  const { maxResults, minSimilarityPct } = await storageGet(DEFAULT_SETTINGS);
  const maxResultsInput = document.getElementById('max-results');
  const minSimInput = document.getElementById('min-similarity');

  maxResultsInput.min = String(DEFAULT_SETTINGS.maxResultsMin);
  maxResultsInput.max = String(DEFAULT_SETTINGS.maxResultsMax);
  minSimInput.min = String(DEFAULT_SETTINGS.minSimilarityMin);
  minSimInput.max = String(DEFAULT_SETTINGS.minSimilarityMax);

  maxResultsInput.value = Number.isFinite(maxResults) ? maxResults : DEFAULT_SETTINGS.maxResults;
  minSimInput.value = Number.isFinite(minSimilarityPct) ? minSimilarityPct : DEFAULT_SETTINGS.minSimilarityPct;
}

async function saveUserSettingsFromForm() {
  const statusEl = document.getElementById('save-status');
  setSaveStatus(statusEl, '', null);

  let maxResults = parseInt(document.getElementById('max-results').value, 10);
  let minSimilarityPct = Number(document.getElementById('min-similarity').value);

  // validate
  if (!Number.isFinite(maxResults)) maxResults = DEFAULT_SETTINGS.maxResults;
  if (!Number.isFinite(minSimilarityPct)) minSimilarityPct = DEFAULT_SETTINGS.minSimilarityPct;

  maxResults = Math.max(DEFAULT_SETTINGS.maxResultsMin, Math.min(DEFAULT_SETTINGS.maxResultsMax, maxResults));
  minSimilarityPct = Math.max(DEFAULT_SETTINGS.minSimilarityMin, Math.min(DEFAULT_SETTINGS.minSimilarityMax, minSimilarityPct));

  try {
    await storageSet({ maxResults, minSimilarityPct });
    setSaveStatus(statusEl, 'Saved', 'is-ok');
    setTimeout(() => setSaveStatus(statusEl, '', null), 1500);
  } catch (e) {
    setSaveStatus(statusEl, 'Error saving', 'is-error');
  }
}

function applyTheme(theme) {
  document.body.classList.toggle('theme-dark', theme === 'dark');
}

function setSaveStatus(el, text, state) {
  if (!el) return;
  el.classList.remove('is-ok', 'is-error');
  if (state) el.classList.add(state);
  el.textContent = text;
}

async function loadThemeToForm() {
  const { theme } = await storageGet(DEFAULT_APPEARANCE);
  const sel = document.getElementById('theme-select');
  const resolved = theme === 'dark' ? 'dark' : 'light';
  if (sel) sel.value = resolved;
  applyTheme(resolved);
}

async function saveThemeFromForm() {
  const sel = document.getElementById('theme-select');
  const statusEl = document.getElementById('theme-save-status');
  const value = sel?.value === 'dark' ? 'dark' : 'light';
  try {
    await storageSet({ theme: value });
    applyTheme(value);
    setSaveStatus(statusEl, 'Saved', 'is-ok');
    setTimeout(() => setSaveStatus(statusEl, '', null), 1500);
  } catch {
    setSaveStatus(statusEl, 'Error', 'is-error');
  }
}

// Request database information
async function loadDatabaseInfo() {
  try {
    const info = await sendMessageToBackground({
      action: 'getDatabaseInfo'
    });
    
    // Update UI with database info
    if (info) {
      document.getElementById('last-update').textContent = formatDate(info.lastUpdate);
      document.getElementById('license-count').textContent = info.licenseCount || 'Not available';
      document.getElementById('licensedb-version').textContent = info.licenseDbVersion || 'Not available';
      document.getElementById('spdx-version').textContent = info.spdxListVersion || 'Not available';
      
      const dbStatus = document.getElementById('db-status');
      dbStatus.classList.remove('is-ok', 'is-error');
      if (info.isInitialized) {
        dbStatus.textContent = 'Initialized';
        dbStatus.classList.add('is-ok');
      } else {
        dbStatus.textContent = 'Not initialized';
        dbStatus.classList.add('is-error');
      }
    }
  } catch (error) {
    console.error('Failed to load database info:', error);
    document.getElementById('last-update').textContent = 'Error loading information';
    document.getElementById('license-count').textContent = 'Error';
    document.getElementById('licensedb-version').textContent = 'Error';
    document.getElementById('spdx-version').textContent = 'Error';
    document.getElementById('db-status').textContent = 'Error';
  }
}

// Refresh the license database
async function refreshDatabase() {
  try {
    // Disable the button during update
    const refreshButton = document.getElementById('refresh-db');
    refreshButton.disabled = true;
    refreshButton.textContent = 'Updating...';
    
    // Show progress bar
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const updateStatus = document.getElementById('update-status');
    
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    updateStatus.textContent = 'Starting database update...';
    
    // Listen for progress updates
    ext.runtime.onMessage.addListener(function progressListener(message) {
      if (message.action === 'updateProgress') {
        progressBar.style.width = `${message.progress}%`;
        updateStatus.textContent = message.message;
        
        // If complete, remove listener
        if (message.progress >= 100 || message.complete) {
          ext.runtime.onMessage.removeListener(progressListener);
        }
      }
    });
    
    // Start the update
    await sendMessageToBackground({
      action: 'refreshDatabase'
    });
    
    // Update the database info
    await loadDatabaseInfo();
  } catch (error) {
    console.error('Failed to refresh database:', error);
    document.getElementById('update-status').textContent = `Error: ${error.message || 'Unknown error'}`;
  } finally {
    // Re-enable the button
    const refreshButton = document.getElementById('refresh-db');
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh License Database';
  }
}

// Reset the database completely
async function resetDatabase() {
  if (confirm('Are you sure you want to reset the database? This will delete all licenses and require a complete redownload.')) {
    try {
      // Disable the button during reset
      const resetButton = document.getElementById('reset-db');
      resetButton.disabled = true;
      resetButton.textContent = 'Resetting...';
      
      // Show progress bar
      const progressContainer = document.getElementById('progress-container');
      const progressBar = document.getElementById('progress-bar');
      const updateStatus = document.getElementById('update-status');
      
      progressContainer.classList.remove('hidden');
      progressBar.style.width = '0%';
      updateStatus.textContent = 'Resetting database...';
      
      // Listen for progress updates
      ext.runtime.onMessage.addListener(function progressListener(message) {
        if (message.action === 'updateProgress') {
          progressBar.style.width = `${message.progress}%`;
          updateStatus.textContent = message.message;
          
          // If complete, remove listener
          if (message.progress >= 100 || message.complete) {
            ext.runtime.onMessage.removeListener(progressListener);
          }
        }
      });
      
      // Start the reset
      await sendMessageToBackground({
        action: 'resetDatabase'
      });
      
      // Update the database info
      await loadDatabaseInfo();
    } catch (error) {
      console.error('Failed to reset database:', error);
      document.getElementById('update-status').textContent = `Error: ${error.message || 'Unknown error'}`;
    } finally {
      // Re-enable the button
      const resetButton = document.getElementById('reset-db');
      resetButton.disabled = false;
      resetButton.textContent = 'Reset Database';
    }
  }
}

// Helper function to send messages to the background script
function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(message, response => {
      if (ext.runtime.lastError) {
        reject(new Error(ext.runtime.lastError.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

// Format date for display
function formatDate(dateString) {
  if (!dateString) return 'Never';
  
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Invalid date';
    
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch (error) {
    console.error('Error formatting date:', error);
    return 'Error';
  }
}
