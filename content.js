// Avoid duplicate UI when dynamically injected multiple times
if (window.__LICENSE_DIFF_LOADED__) {
  console.log('LicenseDB Diff content script already initialized.');
} else {
  window.__LICENSE_DIFF_LOADED__ = true;
  console.log('Content script loaded.');

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

  // Create notifications container
  const notificationsContainer = document.createElement('div');
  notificationsContainer.id = 'license-diff-notifications';
  uiContainer.appendChild(notificationsContainer);

  // Add a status message
  const status = document.createElement('div');
  status.id = 'license-diff-status';
  uiContainer.appendChild(status);

  // Add a progress bar
  const progressBar = document.createElement('div');
  progressBar.id = 'license-diff-progress-container';
  progressBar.innerHTML = `
    <div id="license-diff-progress"></div>
  `;
  uiContainer.appendChild(progressBar);

  // Add a link for matches
  const linkDisplay = document.createElement('div');
  linkDisplay.id = 'license-diff-url';

  // Dropdown for matches
  const dropdown = document.createElement('select');
  dropdown.id = 'license-diff-dropdown';
  uiContainer.appendChild(dropdown);
  uiContainer.appendChild(linkDisplay);

  // Add a container for the diff
  const diffContainer = document.createElement('div');
  diffContainer.id = 'license-diff-display';
  uiContainer.appendChild(diffContainer);

  // Append the UI to the webpage
  document.body.appendChild(uiContainer);

  // Store matches globally
  let matches = [];

  function prettyPercent(pStr) {
    if (pStr === undefined || pStr === null || pStr === '') return '';
    const num = parseFloat(pStr);
    if (isNaN(num)) return '';
    return `${num.toFixed(2)}%`;
  }

  // Function to show notifications that automatically disappear
  function showNotification(message, type = 'info', duration = 5000) {
    const notification = document.createElement('div');
    notification.className = `license-diff-notification ${type}`;
    notification.textContent = message;

    // Add to DOM
    const container = document.getElementById('license-diff-notifications');
    container.appendChild(notification);

    // Show UI if not already visible
    if (uiContainer.style.display !== 'flex') {
      uiContainer.style.display = 'flex';
    }

    // Scroll notification into view if needed
    notification.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Remove after duration
    setTimeout(() => {
      notification.style.animation = 'fadeOut 0.3s ease-in-out';
      notification.addEventListener('animationend', () => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      });
    }, duration);
    
    return notification;
  }

  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ ok: true });
      return; // No async work
    }
    if (message.action === 'showUI') {
      uiContainer.style.display = 'flex';
      sendResponse({ success: true });
    } else if (message.action === 'clearResults') {
      // Clear previous results
      dropdown.innerHTML = '';

      document.getElementById('license-diff-url').innerHTML = '';
      document.getElementById('license-diff-display').innerHTML = '';

      const progressBar = document.getElementById('license-diff-progress');
      // Reset progress
      progressBar.classList.remove('animating');
      progressBar.classList.add('no-transition');
      progressBar.style.width = '0%';
      // Force reflow so the browser applies width without transition
      void progressBar.offsetWidth;
      progressBar.classList.remove('no-transition');

      document.getElementById('license-diff-status').innerText = 'Starting license comparison...';

      // Reset the global matches array
      matches = [];

      sendResponse({ success: true });
    } else if (message.action === 'progressUpdate') {
      const { checked, total } = message.progress;
      const progressPercent = ((checked / total) * 100).toFixed(2);
      const progressBar = document.getElementById('license-diff-progress');

      // Add animation class if not already there
      if (!progressBar.classList.contains('animating') && progressPercent > 0) {
        progressBar.classList.add('animating');
      }

      progressBar.style.width = `${progressPercent}%`;
      document.getElementById('license-diff-status').innerText = `Checked ${checked} of ${total} licenses...`;

      // If progress is complete, remove the animation
      if (checked >= total) {
        setTimeout(() => {
          progressBar.classList.remove('animating');
        }, 500); // Small delay to let the transition complete
      }

      sendResponse({ success: true });
    } else if (message.action === 'showResults') {
      // Stop the progress bar animation
      document.getElementById('license-diff-progress').classList.remove('animating');

      matches = message.matches;

      // Populate dropdown
      matches.forEach(m => {
        // Build link with copy button for later display
        m.link = `<a href="https://scancode-licensedb.aboutcode.org/${m.license}.html" target="_blank" rel="noopener noreferrer">${m.name}</a> 
          <span class=\"spdx-container\">
            <span class=\"spdx-id\">(${m.spdx})</span>
            <button class=\"copy-spdx-button\" data-spdx=\"${m.spdx}\" title=\"Copy ID\">
              <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"></rect><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"></path></svg>
            </button>
          </span>`;
        // Using bracketed label so it appears in native select
        const pct = prettyPercent(m.charSimilarity);
        const opt = document.createElement('option');
        opt.value = m.license;
        opt.textContent = pct ? `${m.license} (${pct} match)` : m.license;
        dropdown.appendChild(opt);
      });

      // Change handler
      dropdown.onchange = () => {
        const sel = matches.find(m => m.license === dropdown.value);
        if (!sel) return;
        document.getElementById('license-diff-url').innerHTML = sel.link;
        
        const a = linkDisplay.querySelector('a');
        if (a) {
          a.setAttribute('rel', 'noopener noreferrer');
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'openExternal', url: a.href });
          }, { passive: false });
        }
        diffContainer.innerHTML = sel.diff;
        setupCopyButtons();
      };

      if (matches.length) {
        dropdown.selectedIndex = 0;
        dropdown.onchange();
      }

      document.getElementById('license-diff-status').innerText = 'Comparison complete!';
      sendResponse({ success: true });
    } else if (message.action === 'showError') {
      // Stop the progress bar animation on error too
      document.getElementById('license-diff-progress').classList.remove('animating');

      document.getElementById('license-diff-status').innerText = `Error: ${message.error}`;
      showNotification(`Error: ${message.error}`, 'error');
      sendResponse({ success: true });
    } else if (message.action === 'showNotification') {
      const { message: notificationText, type } = message.notification;
      showNotification(notificationText, type);
      sendResponse({ success: true });
    }

    // All current branches answer synchronously; do not return true to avoid warning if channel closes.
  });

  // Function to setup copy buttons
  function setupCopyButtons() {
    document.querySelectorAll('.copy-spdx-button').forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        const spdxId = this.getAttribute('data-spdx');

        // Copy to clipboard
        navigator.clipboard.writeText(spdxId)
          .then(() => {
            // Visual feedback - Change button appearance temporarily
            this.classList.add('copied');

            // Show notification
            const notification = showNotification(`Copied "${spdxId}" to clipboard`, 'success', 2000);

            // Reset button after a short delay
            setTimeout(() => {
              this.classList.remove('copied');
            }, 1500);
          })
          .catch(err => {
            console.error('Failed to copy SPDX ID: ', err);
            showNotification('Failed to copy to clipboard', 'error');
          });
      });
    });
  }

  // Add CSS for animations
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeOut {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-10px); }
    }
  `;
  document.head.appendChild(style);

  // Notify the background script that the content script is ready
  try {
    chrome.runtime.sendMessage({ action: 'contentScriptReady' });
  } catch (err) {
    console.warn('Error notifying background script:', err);
  }
} // end guarded initialization