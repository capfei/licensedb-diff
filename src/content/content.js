// Avoid duplicate UI when dynamically injected multiple times
var __LD_STATE__ = (window.__LICENSE_DIFF_STATE__ ||= { initialized: false, initializing: false });

if (__LD_STATE__.initialized || __LD_STATE__.initializing) {
  console.log('LicenseDB Diff content script already initialized (or initializing).');
} else {
  __LD_STATE__.initializing = true;
  try {
    console.log('Content script loaded.');

    const XHTML_NS = 'http://www.w3.org/1999/xhtml';
    const isHtmlDoc = typeof HTMLDocument !== 'undefined' && document instanceof HTMLDocument;
    const createEl = (tag) => (isHtmlDoc ? document.createElement(tag) : document.createElementNS(XHTML_NS, tag));

    const setStyleProp = (el, prop, value) => {
      if (!el) return;
      try {
        if (el.style && typeof el.style[prop] !== 'undefined') {
          el.style[prop] = value;
          return;
        }
      } catch { /* ignore */ }
      const prev = (el.getAttribute && el.getAttribute('style')) || '';
      const next = `${prev}${prev && !prev.trim().endsWith(';') ? ';' : ''}${prop}: ${value};`;
      try { el.setAttribute('style', next); } catch { /* ignore */ }
    };

    const setDisplay = (el, value) => setStyleProp(el, 'display', value);

    const safeClearHTML = (el) => {
      if (!el) return;
      try {
        if ('innerHTML' in el) el.innerHTML = '';
        else el.textContent = '';
      } catch {
        try { el.textContent = ''; } catch { /* ignore */ }
      }
    };

    const safeSetHTML = (el, html) => {
      if (!el) return;

      try {
        if ('innerHTML' in el) {
          el.innerHTML = html;
          return;
        }
      } catch {
        // fall through
      }

      try {
        safeClearHTML(el);

        const parser = new DOMParser();
        const doc = parser.parseFromString(`<!doctype html><body>${html}`, 'text/html');

        const nodes = Array.from(doc.body.childNodes);
        for (const node of nodes) {
          const adopted = document.importNode ? document.importNode(node, true) : node.cloneNode(true);
          el.appendChild(adopted);
        }
      } catch {
        try { el.textContent = html; } catch { /* ignore */ }
      }
    };

    const hasClass = (el, cls) => {
      try { return !!el?.classList?.contains(cls); } catch { return false; }
    };
    const addClass = (el, cls) => {
      try { el?.classList?.add(cls); } catch { /* ignore */ }
    };
    const removeClass = (el, cls) => {
      try { el?.classList?.remove(cls); } catch { /* ignore */ }
    };

    const uiContainer = createEl('div');
    uiContainer.id = 'license-diff-ui';

    const getMountNode = () => document.body || document.documentElement;
    const ensureMounted = () => {
      const mountNode = getMountNode();
      if (!mountNode) return false;
      try {
        const connected = typeof uiContainer.isConnected === 'boolean' ? uiContainer.isConnected : !!uiContainer.parentNode;
        if (!connected) mountNode.appendChild(uiContainer);
      } catch { /* ignore */ }
      return true;
    };

    const toolbar = createEl('div');
    toolbar.id = 'license-diff-toolbar';
    uiContainer.appendChild(toolbar);

    async function getUserTheme() {
      return new Promise((resolve) => {
        try {
          chrome.storage?.sync?.get({ theme: 'light' }, (items) => {
            resolve(items?.theme === 'dark' ? 'dark' : 'light');
          });
        } catch {
          resolve('light');
        }
      });
    }

    function applyThemeClass(theme) {
      removeClass(uiContainer, 'ld-theme-light');
      removeClass(uiContainer, 'ld-theme-dark');
      addClass(uiContainer, theme === 'dark' ? 'ld-theme-dark' : 'ld-theme-light');
    }

    function saveTheme(theme) {
      try { chrome.storage?.sync?.set({ theme }); } catch { /* ignore */ }
    }

    const closeButton = createEl('button');
    closeButton.className = 'license-diff-close';
    closeButton.innerText = '×';
    closeButton.addEventListener('click', () => {
      setDisplay(uiContainer, 'none');
    });
    toolbar.appendChild(closeButton);

    const notificationsContainer = createEl('div');
    notificationsContainer.id = 'license-diff-notifications';
    uiContainer.appendChild(notificationsContainer);

    const status = createEl('div');
    status.id = 'license-diff-status';
    uiContainer.appendChild(status);

    const progressBar = createEl('div');
    progressBar.id = 'license-diff-progress-container';
    const progressEl = createEl('div');
    progressEl.id = 'license-diff-progress';
    progressBar.appendChild(progressEl);
    uiContainer.appendChild(progressBar);

    const linkDisplay = createEl('div');
    linkDisplay.id = 'license-diff-url';
    setDisplay(linkDisplay, 'none');

    const dropdown = createEl('select');
    dropdown.id = 'license-diff-dropdown';
    setDisplay(dropdown, 'none');
    uiContainer.appendChild(dropdown);
    uiContainer.appendChild(linkDisplay);

    const diffContainer = createEl('div');
    diffContainer.id = 'license-diff-display';
    setDisplay(diffContainer, 'none');
    uiContainer.appendChild(diffContainer);

    ensureMounted();

    let matches = [];

    function prettyPercent(pStr) {
      if (pStr === undefined || pStr === null || pStr === '') return '';
      const num = parseFloat(pStr);
      if (isNaN(num)) return '';
      return `${num.toFixed(2)}%`;
    }

    const getSourceClass = (source) => (source === 'spdx' ? 'source-spdx' : 'source-licensedb');
    const getSourceLabel = (source) => (source === 'spdx' ? 'SPDX' : 'ScanCode');


    function showNotification(message, type = 'info', duration = 5000) {
      ensureMounted();

      const notification = createEl('div');
      notification.className = `license-diff-notification ${type}`;
      notification.textContent = message;

      notificationsContainer.appendChild(notification);

      if ((uiContainer.style?.display || '') !== 'flex') setDisplay(uiContainer, 'flex');

      try { notification.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }

      setTimeout(() => {
        setStyleProp(notification, 'animation', 'fadeOut 0.3s ease-in-out');
        notification.addEventListener('animationend', () => {
          try { notification.parentNode?.removeChild(notification); } catch { /* ignore */ }
        });
      }, duration);

      return notification;
    }

    const themeRow = createEl('div');
    themeRow.id = 'license-diff-theme';
    const themeLabel = createEl('label');
    themeLabel.textContent = 'Theme';
    themeLabel.setAttribute('for', 'license-diff-theme-select');
    const themeSelect = createEl('select');
    themeSelect.id = 'license-diff-theme-select';
    themeSelect.innerHTML = `
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    `;
    themeRow.appendChild(themeLabel);
    themeRow.appendChild(themeSelect);
    toolbar.insertBefore(themeRow, toolbar.firstChild);

    getUserTheme().then(theme => {
      applyThemeClass(theme);
      themeSelect.value = theme;
    });

    themeSelect.addEventListener('change', () => {
      const theme = themeSelect.value === 'dark' ? 'dark' : 'light';
      applyThemeClass(theme);
      saveTheme(theme);
    });

    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'sync' && changes.theme) {
          const theme = changes.theme.newValue === 'dark' ? 'dark' : 'light';
          applyThemeClass(theme);
          themeSelect.value = theme;
        }
      });
    } catch { /* ignore */ }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        ensureMounted();

        if (message.action === 'ping') {
          sendResponse({ ok: true });
          return;
        }

        if (message.action === 'showUI') {
          getUserTheme().then(applyThemeClass);
          setDisplay(uiContainer, 'flex');
          updateDiffSizing();
          sendResponse({ success: true });
        } else if (message.action === 'clearResults') {
          safeClearHTML(dropdown);
          setDisplay(dropdown, 'none');

          setDisplay(linkDisplay, 'none');
          safeClearHTML(linkDisplay);

          setDisplay(diffContainer, 'none');
          safeClearHTML(diffContainer);

          if (progressEl) {
            removeClass(progressEl, 'animating');
            addClass(progressEl, 'no-transition');
            setStyleProp(progressEl, 'width', '0%');
            try { void progressEl.offsetWidth; } catch { /* ignore */ }
            removeClass(progressEl, 'no-transition');
          }

          status.textContent = 'Starting license comparison...';
          matches = [];

          sendResponse({ success: true });
        } else if (message.action === 'progressUpdate') {
          const { checked, total } = message.progress;
          const progressPercent = ((checked / total) * 100).toFixed(2);

          if (progressEl) {
            if (!hasClass(progressEl, 'animating') && progressPercent > 0) addClass(progressEl, 'animating');
            setStyleProp(progressEl, 'width', `${progressPercent}%`);

            if (checked >= total) {
              setTimeout(() => removeClass(progressEl, 'animating'), 500);
            }
          }

          status.textContent = `Checked ${checked} of ${total} licenses...`;
          sendResponse({ success: true });
        } else if (message.action === 'showResults') {
          removeClass(progressEl, 'animating');

          matches = Array.isArray(message.matches) ? message.matches : [];
          safeClearHTML(dropdown);

          matches.forEach(m => {
            const matchKey = `${m.source || 'licensedb'}:${m.license}`;
            m.matchKey = matchKey;
            const targetUrl = m.link || `https://scancode-licensedb.aboutcode.org/${m.license}.html`;
            const sourceLabel = getSourceLabel(m.source);
            m.sourceLabel = sourceLabel;

            m.link = `<a href="${targetUrl}" target="_blank">${m.name}</a>
              <span class="source-badge ${getSourceClass(m.source)}">${sourceLabel}</span>
              <span class="spdx-container">
                <span class="spdx-id">(${m.spdx})</span>
                <button class="copy-spdx-button" data-spdx="${m.spdx}" title="Copy ID">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </span>`;
            const pct = prettyPercent(m.charSimilarity);
            const opt = createEl('option');
            opt.value = matchKey;
              opt.textContent = pct ? `${m.license} • ${pct} • ${sourceLabel}` : `${m.license} • ${sourceLabel}`;
            dropdown.appendChild(opt);
          });

          dropdown.onchange = () => {
            const sel = matches.find(m => m.matchKey === dropdown.value);
            if (!sel) return;

            safeSetHTML(linkDisplay, sel.link);

            const a = linkDisplay.querySelector?.('a');
            if (a) {
              a.setAttribute('rel', 'noopener noreferrer');
              a.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                chrome.runtime.sendMessage({ action: 'openExternal', url: a.href });
              }, { passive: false });
            }

            safeSetHTML(diffContainer, sel.diff);
            updateDiffSizing();
            setupCopyButtons();
          };

          setDisplay(dropdown, 'block');
          setDisplay(linkDisplay, 'block');
          setDisplay(diffContainer, 'block');

          if (matches.length) {
            dropdown.selectedIndex = 0;
            dropdown.onchange();
          }

          status.textContent = 'Comparison complete!';
          updateDiffSizing();
          sendResponse({ success: true });
        } else if (message.action === 'showError') {
          removeClass(progressEl, 'animating');
          status.textContent = `Error: ${message.error}`;
          showNotification(`Error: ${message.error}`, 'error');
          sendResponse({ success: true });
        } else if (message.action === 'showNotification') {
          const { message: notificationText, type } = message.notification;
          showNotification(notificationText, type);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Unknown action' });
        }
      } catch (err) {
        try { sendResponse({ success: false, error: String(err?.message || err) }); } catch { /* ignore */ }
      }
    });

    function setupCopyButtons() {
      document.querySelectorAll('.copy-spdx-button').forEach(button => {
        button.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();

          const spdxId = this.getAttribute('data-spdx');

          navigator.clipboard.writeText(spdxId)
            .then(() => {
              this.classList.add('copied');
              showNotification(`Copied "${spdxId}" to clipboard`, 'success', 2000);
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

    const updateDiffSizing = () => {
      try {
        ensureMounted();

        setStyleProp(diffContainer, 'height', 'auto');
        setStyleProp(diffContainer, 'overflow', 'auto');

        const rect = diffContainer.getBoundingClientRect?.();
        const top = rect?.top ?? 0;
        const padding = 16;
        const available = Math.max(160, Math.floor(window.innerHeight - top - padding));

        setStyleProp(diffContainer, 'max-height', `${available}px`);
      } catch {
        /* ignore */
      }
    };

    window.addEventListener('resize', updateDiffSizing, { passive: true });

    const styleId = 'license-diff-inline-style';
    const existingStyle = document.getElementById?.(styleId);
    const style = existingStyle || createEl('style');
    style.id = styleId;
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
    if (!existingStyle) (document.head || document.documentElement).appendChild(style);

    try {
      chrome.runtime.sendMessage({ action: 'contentScriptReady' });
    } catch (err) {
      console.warn('Error notifying background script:', err);
    }

    __LD_STATE__.initialized = true;
  } catch (err) {
    console.error('LicenseDB Diff content script init failed:', err);
    __LD_STATE__.initialized = false;
  } finally {
    __LD_STATE__.initializing = false;
  }
}
