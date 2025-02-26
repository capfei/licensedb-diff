console.log('Content script loaded.');
chrome.runtime.sendMessage({ action: 'contentScriptReady' });

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
const title = document.createElement('h2');
title.innerText = 'License Matcher';
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
uiContainer.appendChild(dropdown);
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

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received in content script:', message);

  if (message.action === 'showUI') {
    uiContainer.style.display = 'block';
    sendResponse({ success: true });
  } else if (message.action === 'progressUpdate') {
    const { checked, total } = message.progress;
    const progressPercent = ((checked / total) * 100).toFixed(2);
    document.getElementById('license-diff-progress').style.width = `${progressPercent}%`;
    document.getElementById('license-diff-status').innerText = `Checked ${checked} of ${total} licenses...`;
    sendResponse({ success: true });
  } else if (message.action === 'showResults') {
    matches = message.matches;

    // Clear the dropdown
    const dropdown = document.getElementById('license-diff-dropdown');
    dropdown.innerHTML = '';

    // Add an option for each match
    matches.forEach(match => {
      const option = document.createElement('option');
      option.value = match.license;
      option.text = `${match.license} (${match.score}% match)`;
      match.link = `<a href="https://scancode-licensedb.aboutcode.org/${match.license}.html" target="_blank">${match.name} (${match.spdx})</a>`;
      dropdown.appendChild(option);
    });

    // Show the first match's diff by default
    if (matches.length > 0) {
      document.getElementById('license-diff-url').innerHTML = matches[0].link;
      document.getElementById('license-diff-display').innerHTML = matches[0].diff;
    }

    document.getElementById('license-diff-status').innerText = 'Comparison complete!';
    sendResponse({ success: true });
  } else if (message.action === 'showError') {
    document.getElementById('license-diff-status').innerText = `Error: ${message.error}`;
    sendResponse({ success: true });
  }

  return true; // Required to use sendResponse asynchronously
});

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((msg) => {
    if (msg.function == 'html') {
      port.postMessage({ html: document.documentElement.outerHTML, description: document.querySelector("meta[name=\'description\']").getAttribute('content'), title: document.title });
    }
  });
});