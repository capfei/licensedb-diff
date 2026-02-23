import { UI_DEFAULTS } from "../../shared/ui-defaults.js";

const FILTER_DEFAULT = UI_DEFAULTS.scanFilter;

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
  const { scanFilter } = await storageGet({ scanFilter: FILTER_DEFAULT });
  document.querySelectorAll('input[name="scanFilter"]').forEach((input) => {
    input.checked = input.value === scanFilter;
    input.addEventListener('change', async () => {
      if (input.checked) await storageSet({ scanFilter: input.value });
    });
  });

  document.getElementById('run-scan').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="scanFilter"]:checked')?.value || FILTER_DEFAULT;
    try {
      await chrome.runtime.sendMessage({ action: 'startScanWithFilter', filter: selected });
    } catch (err) {
      console.error('Failed to start scan:', err);
    } finally {
      window.close();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
