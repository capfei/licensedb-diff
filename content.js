console.log('Content script loaded.');

// Notify the background script that the content script is ready
try {
  chrome.runtime.sendMessage({ action: 'contentScriptReady' }, response => {
    if (chrome.runtime.lastError) {
      // It's okay if this fails, just log it
      console.log('Background script not ready yet:', chrome.runtime.lastError.message);
    } else {
      console.log('Background script acknowledged content script is ready');
    }
  });
} catch (err) {
  console.warn('Error notifying background script:', err);
}

// Set up access to DiffMatchPatch
let DiffMatchPatchClass;

// Try to find the correct diff_match_patch implementation
if (typeof diff_match_patch !== 'undefined') {
  DiffMatchPatchClass = diff_match_patch;
} else if (typeof DiffMatchPatch !== 'undefined') {
  DiffMatchPatchClass = DiffMatchPatch;
} else {
  console.error('DiffMatchPatch not found');
  // Create a fallback
  DiffMatchPatchClass = class {
    diff_main() { return []; }
    diff_cleanupSemantic() {}
    diff_prettyHtml() { return '<p>Diff unavailable</p>'; }
  };
}

// Create a container for the UI
const uiContainer = document.createElement('div');
uiContainer.id = 'license-diff-ui';

// Add a close button
const closeButton = document.createElement('button');
closeButton.innerText = '×';
closeButton.addEventListener('click', () => {
  uiContainer.style.display = 'none';
});
uiContainer.appendChild(closeButton);

// Add a title
const title = document.createElement('h4');
title.innerText = 'Licenses';
uiContainer.appendChild(title);

// Add a status message
const status = document.createElement('div');
status.id = 'license-diff-status';
uiContainer.appendChild(status);

// Add a progress bar
const progressBar = document.createElement('div');
progressBar.style.width = '100%';
progressBar.style.backgroundColor = '#ddd';
progressBar.style.borderRadius = '5px';
progressBar.style.marginBottom = '10px';
progressBar.innerHTML = `
  <div id="license-diff-progress"></div>
`;
uiContainer.appendChild(progressBar);

// Add a link for matches
const linkDisplay = document.createElement('div');
linkDisplay.id = 'license-diff-url';

// Add a dropdown container that we can show/hide
const dropdownContainer = document.createElement('div');
dropdownContainer.id = 'license-dropdown-container';
dropdownContainer.style.display = 'none'; // Hide initially
dropdownContainer.style.width = '100%';

// Add a dropdown for matches
const dropdown = document.createElement('select');
dropdown.id = 'license-diff-dropdown';
dropdown.style.width = '100%';
dropdown.style.marginBottom = '10px';
dropdown.style.padding = '5px';
dropdown.addEventListener('change', (event) => {
  const selectedMatch = matches.find(match => match.license === event.target.value);
  if (selectedMatch) {
    document.getElementById('license-diff-url').innerHTML = selectedMatch.link;
    document.getElementById('license-diff-display').innerHTML = selectedMatch.diff;
  }
});
dropdownContainer.appendChild(dropdown);
uiContainer.appendChild(dropdownContainer);
uiContainer.appendChild(linkDisplay);

// Add a container for the diff
const diffContainer = document.createElement('div');
diffContainer.id = 'license-diff-display';
diffContainer.style.marginTop = '10px';
uiContainer.appendChild(diffContainer);

// Append the UI to the webpage
document.body.appendChild(uiContainer);

// Store matches globally
let matches = [];

// Listen for messages from the background script with better error handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received in content script:', message);
  
  try {
    if (message.action === 'showUI') {
      uiContainer.style.display = 'flex';
      
      // Reset UI elements for a new comparison
      document.getElementById('license-dropdown-container').style.display = 'none';
      document.getElementById('license-diff-url').innerHTML = '';
      document.getElementById('license-diff-display').innerHTML = '';
      document.getElementById('license-diff-status').innerText = 'Starting license comparison...';
      document.getElementById('license-diff-progress').style.width = '0%';
      
      sendResponse({ success: true });
    } else if (message.action === 'progressUpdate') {
      const { checked, total, promising, message: statusMessage } = message.progress;
      const progressPercent = ((checked / total) * 100).toFixed(2);
      document.getElementById('license-diff-progress').style.width = `${progressPercent}%`;
      
      // Show custom message if provided, otherwise use default
      if (statusMessage) {
        document.getElementById('license-diff-status').innerText = statusMessage;
      } else {
        document.getElementById('license-diff-status').innerText = 
          `Checked ${checked} of ${total} licenses... (${promising || 0} potential matches)`;
      }
      
      // Don't update the dropdown UI with partial results
      sendResponse({ success: true });
    } else if (message.action === 'showResults') {
      try {
        matches = message.matches || [];
        
        if (matches.length > 0) {
          updateResultsUI(matches);
          document.getElementById('license-diff-status').innerText = 'Comparison complete!';
          
          // Show the dropdown container only after comparison is complete
          document.getElementById('license-dropdown-container').style.display = 'block';
        } else {
          document.getElementById('license-diff-status').innerText = 'No matching licenses found.';
          document.getElementById('license-dropdown-container').style.display = 'none';
        }
      } catch (error) {
        console.error('Error showing results:', error);
        document.getElementById('license-diff-status').innerText = `Error displaying results: ${error.message}`;
      }
      sendResponse({ success: true });
    } else if (message.action === 'showError') {
      document.getElementById('license-diff-status').innerText = `Error: ${message.error}`;
      document.getElementById('license-dropdown-container').style.display = 'none';
      sendResponse({ success: true });
    } else {
      // Unknown action
      sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      // Try to report the error back
      sendResponse({ success: false, error: error.message });
    } catch (innerError) {
      console.error('Failed to send error response:', innerError);
    }
  }

  return true; // Required to use sendResponse asynchronously
});

// Helper function to update the UI with results - with error handling
function updateResultsUI(results, isPartial = false) {
  try {
    // Store matches globally if these are the final results
    if (!isPartial) {
      matches = results || [];
    }
    
    if (!results || results.length === 0) {
      document.getElementById('license-diff-status').innerText = 'No matching licenses found.';
      document.getElementById('license-dropdown-container').style.display = 'none';
      return;
    }

    // Only proceed with UI updates for final results, not partial ones
    if (isPartial) return;

    // Generate diffs for display
    try {
      const dmp = new DiffMatchPatchClass();
      const selectedText = document.getSelection().toString();
      
      results.forEach(match => {
        // Always regenerate diff in content script
        try {
          // Create safe versions of texts to use with diff
          const safeText = selectedText || '';
          const safeLicenseText = match.licenseText || '';
          
          // Make diff case insensitive by converting texts to lowercase
          const lowerText = safeText.toLowerCase();
          const lowerLicenseText = safeLicenseText.toLowerCase();
          
          const d = dmp.diff_main(lowerText, lowerLicenseText);
          dmp.diff_cleanupSemantic(d);
          match.diff = dmp.diff_prettyHtml(d);
          match.link = `<a href="https://scancode-licensedb.aboutcode.org/${match.license}.html" target="_blank">${match.name || match.license}</a> (${match.spdx || 'unknown'})`;
        } catch (diffError) {
          console.error('Error generating diff for', match.license, diffError);
          match.diff = `<p>Error generating diff: ${diffError.message}</p>`;
          match.link = `<a href="https://scancode-licensedb.aboutcode.org/${match.license}.html" target="_blank">${match.name || match.license}</a>`;
        }
      });
    } catch (diffError) {
      console.error('Error in diff generation:', diffError);
    }

    // Clear the dropdown
    const dropdown = document.getElementById('license-diff-dropdown');
    dropdown.innerHTML = '';

    // Add an option for each match
    results.forEach(match => {
      const option = document.createElement('option');
      option.value = match.license;
      option.text = `${match.license} (${match.score}% match)`;
      dropdown.appendChild(option);
    });

    // Show the first match's diff by default
    if (results.length > 0) {
      document.getElementById('license-diff-url').innerHTML = results[0].link || '';
      document.getElementById('license-diff-display').innerHTML = results[0].diff || 'No diff available';
    }
  } catch (error) {
    console.error('Error updating results UI:', error);
    document.getElementById('license-diff-status').innerText = `Error updating UI: ${error.message}`;
  }
}

// Handle connection requests more robustly
chrome.runtime.onConnect.addListener((port) => {
  console.log('Connection established from', port.name);
  
  port.onMessage.addListener((msg) => {
    try {
      if (msg.function == 'html') {
        // Get the HTML safely
        const docHtml = document.documentElement.outerHTML || '';
        
        // Safely get description
        let description = '';
        try {
          const metaDesc = document.querySelector("meta[name='description']");
          description = metaDesc ? metaDesc.getAttribute('content') : '';
        } catch (err) {
          console.warn('Error getting description:', err);
        }
        
        // Get title safely
        const title = document.title || '';
        
        port.postMessage({ 
          html: docHtml, 
          description: description, 
          title: title 
        });
      }
    } catch (err) {
      console.error('Error processing port message:', err);
      // Try to respond with an error
      try {
        port.postMessage({ error: err.message });
      } catch (postErr) {
        console.error('Failed to send error via port:', postErr);
      }
    }
  });
  
  // Handle disconnection gracefully
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.log('Port disconnected:', chrome.runtime.lastError.message);
    } else {
      console.log('Port disconnected');
    }
  });
});