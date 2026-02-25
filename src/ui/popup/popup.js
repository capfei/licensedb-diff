import { UI_DEFAULTS } from "../../shared/ui-defaults.js";

const FILTER_DEFAULT = UI_DEFAULTS.scanFilter;
const DEPRECATED_DEFAULT = UI_DEFAULTS.includeDeprecated;
const SCAN_SOURCE_DEFAULT = UI_DEFAULTS.scanSource;
const THEME_DEFAULT = UI_DEFAULTS.theme;

function storageGet(defaults) {
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.get(defaults, (items) => resolve(items || defaults));
    } catch {
      resolve(defaults);
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage?.sync?.set(obj, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function init() {
  const { scanFilter, includeDeprecated, scanSource, theme } = await storageGet({
    scanFilter: FILTER_DEFAULT,
    includeDeprecated: DEPRECATED_DEFAULT,
    scanSource: SCAN_SOURCE_DEFAULT,
    theme: THEME_DEFAULT
  });

  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.querySelectorAll('input[name="scanFilter"]').forEach((input) => {
    input.checked = input.value === scanFilter;
    input.addEventListener('change', async () => {
      if (input.checked) await storageSet({ scanFilter: input.value });
    });
  });

  const deprecatedCheckbox = document.getElementById('include-deprecated');
  deprecatedCheckbox.checked = !!includeDeprecated;
  deprecatedCheckbox.addEventListener('change', async () => {
    await storageSet({ includeDeprecated: deprecatedCheckbox.checked });
  });

  document.querySelectorAll('input[name="scanSource"]').forEach((input) => {
    input.checked = input.value === scanSource;
    input.addEventListener('change', async () => {
      if (input.checked) await storageSet({ scanSource: input.value });
    });
  });

  document.getElementById('run-scan').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="scanFilter"]:checked')?.value || FILTER_DEFAULT;
    const selectedSource = document.querySelector('input[name="scanSource"]:checked')?.value || SCAN_SOURCE_DEFAULT;
    try {
      await chrome.runtime.sendMessage({
        action: 'startScanWithFilter',
        filter: selected,
        includeDeprecated: deprecatedCheckbox.checked,
        scanSource: selectedSource
      });
    } catch (err) {
      console.error('Failed to start scan:', err);
    } finally {
      window.close();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
