document.addEventListener('DOMContentLoaded', async function() {
  // Initialize UI
  await loadDatabaseInfo();

  // Load settings UI
  await loadUserSettingsToForm();

  // Set up button event listeners
  document.getElementById('refresh-db').addEventListener('click', refreshDatabase);
  document.getElementById('reset-db').addEventListener('click', resetDatabase);
  document.getElementById('save-settings').addEventListener('click', saveUserSettingsFromForm);
});

// Defaults aligned with background CONFIG
const DEFAULT_SETTINGS = {
  maxResults: 10,
  minSimilarityPct: 15
};

function storageGet(keysWithDefaults) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(keysWithDefaults, (items) => resolve(items || keysWithDefaults));
    } catch {
      resolve(keysWithDefaults);
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.sync.set(obj, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
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

  maxResultsInput.value = Number.isFinite(maxResults) ? maxResults : DEFAULT_SETTINGS.maxResults;
  minSimInput.value = Number.isFinite(minSimilarityPct) ? minSimilarityPct : DEFAULT_SETTINGS.minSimilarityPct;
}

async function saveUserSettingsFromForm() {
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '';

  let maxResults = parseInt(document.getElementById('max-results').value, 10);
  let minSimilarityPct = Number(document.getElementById('min-similarity').value);

  // validate
  if (!Number.isFinite(maxResults)) maxResults = DEFAULT_SETTINGS.maxResults;
  if (!Number.isFinite(minSimilarityPct)) minSimilarityPct = DEFAULT_SETTINGS.minSimilarityPct;

  maxResults = Math.max(1, Math.min(100, maxResults));
  minSimilarityPct = Math.max(0, Math.min(100, minSimilarityPct));

  try {
    await storageSet({ maxResults, minSimilarityPct });
    statusEl.style.color = '#4CAF50';
    statusEl.textContent = 'Saved';
    setTimeout(() => (statusEl.textContent = ''), 1500);
  } catch (e) {
    statusEl.style.color = '#dc3545';
    statusEl.textContent = 'Error saving';
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
      
      const dbStatus = document.getElementById('db-status');
      if (info.isInitialized) {
        dbStatus.textContent = 'Initialized';
        dbStatus.style.color = '#4CAF50';
      } else {
        dbStatus.textContent = 'Not initialized';
        dbStatus.style.color = '#dc3545';
      }
    }
  } catch (error) {
    console.error('Failed to load database info:', error);
    document.getElementById('last-update').textContent = 'Error loading information';
    document.getElementById('license-count').textContent = 'Error';
    document.getElementById('licensedb-version').textContent = 'Error';
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
    chrome.runtime.onMessage.addListener(function progressListener(message) {
      if (message.action === 'updateProgress') {
        progressBar.style.width = `${message.progress}%`;
        updateStatus.textContent = message.message;
        
        // If complete, remove listener
        if (message.progress >= 100 || message.complete) {
          chrome.runtime.onMessage.removeListener(progressListener);
        }
      }
      return true;
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
      chrome.runtime.onMessage.addListener(function progressListener(message) {
        if (message.action === 'updateProgress') {
          progressBar.style.width = `${message.progress}%`;
          updateStatus.textContent = message.message;
          
          // If complete, remove listener
          if (message.progress >= 100 || message.complete) {
            chrome.runtime.onMessage.removeListener(progressListener);
          }
        }
        return true;
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
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
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