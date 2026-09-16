// Resolve the correct WebExtension API namespace
const ext = globalThis.browser ?? globalThis.chrome;

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
          ext.storage?.sync?.get({ theme: 'light' }, (items) => {
            resolve(items?.theme === 'dark' ? 'dark' : 'light');
          });
        } catch {
          resolve('light');
        }
      });
    }

    async function getResultGroupingMode() {
      return new Promise((resolve) => {
        try {
          ext.storage?.sync?.get({ resultGrouping: 'overall' }, (items) => {
            resolve(items?.resultGrouping === 'bySource' ? 'bySource' : 'overall');
          });
        } catch {
          resolve('overall');
        }
      });
    }

    function applyThemeClass(theme) {
      removeClass(uiContainer, 'ld-theme-light');
      removeClass(uiContainer, 'ld-theme-dark');
      addClass(uiContainer, theme === 'dark' ? 'ld-theme-dark' : 'ld-theme-light');
    }

    function saveTheme(theme) {
      try { ext.storage?.sync?.set({ theme }); } catch { /* ignore */ }
    }

    const closeButton = createEl('button');
    closeButton.className = 'license-diff-close';
    closeButton.innerText = '\u00d7';
    closeButton.setAttribute('aria-label', 'Close license comparison');
    closeButton.title = 'Close license comparison';
    closeButton.addEventListener('click', () => {
      setDisplay(uiContainer, 'none');
    });
    toolbar.appendChild(closeButton);

    const notificationsContainer = createEl('div');
    notificationsContainer.id = 'license-diff-notifications';
    notificationsContainer.setAttribute('role', 'status');
    notificationsContainer.setAttribute('aria-live', 'polite');
    uiContainer.appendChild(notificationsContainer);

    const status = createEl('div');
    status.id = 'license-diff-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    uiContainer.appendChild(status);

    const progressBar = createEl('div');
    progressBar.id = 'license-diff-progress-container';
    progressBar.setAttribute('aria-hidden', 'true');
    const progressEl = createEl('div');
    progressEl.id = 'license-diff-progress';
    progressBar.appendChild(progressEl);
    uiContainer.appendChild(progressBar);

    const linkDisplay = createEl('div');
    linkDisplay.id = 'license-diff-url';
    setDisplay(linkDisplay, 'none');

    let resultGroupingMode = 'overall';

    const groupingRow = createEl('div');
    groupingRow.id = 'license-diff-result-grouping';
    setDisplay(groupingRow, 'none');
    const groupingLabel = createEl('label');
    groupingLabel.setAttribute('for', 'license-diff-result-grouping-select');
    groupingLabel.textContent = 'Results grouping';
    const groupingSelect = createEl('select');
    groupingSelect.id = 'license-diff-result-grouping-select';
    groupingSelect.innerHTML = `
      <option value="overall">Top overall</option>
      <option value="bySource">Group by source</option>
    `;
    groupingRow.appendChild(groupingLabel);
    groupingRow.appendChild(groupingSelect);
    toolbar.insertBefore(groupingRow, closeButton);

    // Custom listbox: a native <select> cannot render two-line rows with a
    // right-aligned score and a muted source line.
    const picker = createEl('div');
    picker.id = 'license-diff-picker';
    setDisplay(picker, 'none');

    const pickerButton = createEl('button');
    pickerButton.type = 'button';
    pickerButton.id = 'license-diff-picker-button';
    pickerButton.setAttribute('role', 'combobox');
    pickerButton.setAttribute('aria-haspopup', 'listbox');
    pickerButton.setAttribute('aria-expanded', 'false');
    pickerButton.setAttribute('aria-controls', 'license-diff-picker-list');
    pickerButton.setAttribute('aria-label', 'Matched license');

    const pickerList = createEl('div');
    pickerList.id = 'license-diff-picker-list';
    pickerList.setAttribute('role', 'listbox');
    pickerList.setAttribute('tabindex', '-1');
    setDisplay(pickerList, 'none');

    picker.appendChild(pickerButton);
    picker.appendChild(pickerList);

    uiContainer.appendChild(picker);
    uiContainer.appendChild(linkDisplay);

    const metaPanel = createEl('div');
    metaPanel.id = 'license-diff-meta';
    setDisplay(metaPanel, 'none');
    uiContainer.appendChild(metaPanel);

    const diffToolbar = createEl('div');
    diffToolbar.id = 'license-diff-diff-toolbar';
    setDisplay(diffToolbar, 'none');

    const changeNav = createEl('div');
    changeNav.className = 'ldiff-nav';
    const prevChangeBtn = createEl('button');
    prevChangeBtn.type = 'button';
    prevChangeBtn.className = 'ldiff-tool-btn';
    prevChangeBtn.textContent = '\u2191';
    prevChangeBtn.title = 'Previous change';
    prevChangeBtn.setAttribute('aria-label', 'Previous change');
    const changeCounter = createEl('span');
    changeCounter.className = 'ldiff-nav-counter';
    changeCounter.setAttribute('aria-live', 'polite');
    const nextChangeBtn = createEl('button');
    nextChangeBtn.type = 'button';
    nextChangeBtn.className = 'ldiff-tool-btn';
    nextChangeBtn.textContent = '\u2193';
    nextChangeBtn.title = 'Next change';
    nextChangeBtn.setAttribute('aria-label', 'Next change');
    changeNav.appendChild(prevChangeBtn);
    changeNav.appendChild(changeCounter);
    changeNav.appendChild(nextChangeBtn);

    const toolSpacer = createEl('div');
    toolSpacer.className = 'ldiff-tool-spacer';

    const foldToggle = createEl('button');
    foldToggle.type = 'button';
    foldToggle.className = 'ldiff-tool-btn ldiff-tool-toggle';
    foldToggle.textContent = 'Only changes';
    foldToggle.title = 'Collapse long unchanged passages';
    foldToggle.setAttribute('aria-pressed', 'false');

    const copyDiffBtn = createEl('button');
    copyDiffBtn.type = 'button';
    copyDiffBtn.className = 'ldiff-tool-btn';
    copyDiffBtn.textContent = 'Copy diff';
    copyDiffBtn.title = 'Copy the diff as text';

    const copyRefBtn = createEl('button');
    copyRefBtn.type = 'button';
    copyRefBtn.className = 'ldiff-tool-btn';
    copyRefBtn.textContent = 'Copy reference';
    copyRefBtn.title = 'Copy the reference license text';

    diffToolbar.appendChild(changeNav);
    diffToolbar.appendChild(toolSpacer);
    diffToolbar.appendChild(foldToggle);
    diffToolbar.appendChild(copyDiffBtn);
    diffToolbar.appendChild(copyRefBtn);
    uiContainer.appendChild(diffToolbar);

    const diffContainer = createEl('div');
    diffContainer.id = 'license-diff-display';
    setDisplay(diffContainer, 'none');
    uiContainer.appendChild(diffContainer);

    ensureMounted();

    let matches = [];
    let selectedMatchKey = null;
    let activeOptionIndex = -1;
    let onSelectionChange = null;

    const getOptionNodes = () => Array.from(pickerList.querySelectorAll?.('[role="option"]') || []);

    function buildOptionRow(m, index) {
      const pct = prettyPercent(m.charSimilarity);
      const sourceLabel = m.sourceLabel || getSourceLabel(m.source);

      const row = createEl('div');
      row.className = 'ldiff-opt';
      row.id = `license-diff-opt-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('data-key', m.matchKey);
      row.setAttribute('aria-selected', String(m.matchKey === selectedMatchKey));
      row.title = m.name || m.license;

      const main = createEl('span');
      main.className = 'ldiff-opt-main';
      const id = createEl('span');
      id.className = 'ldiff-opt-id';
      id.textContent = m.license;
      const score = createEl('span');
      score.className = 'ldiff-opt-pct';
      score.textContent = pct;
      main.appendChild(id);
      main.appendChild(score);

      const sub = createEl('span');
      sub.className = 'ldiff-opt-sub';
      const src = createEl('span');
      src.className = `ldiff-opt-src ${getSourceClass(m.source)}`;
      src.textContent = sourceLabel;
      sub.appendChild(src);
      if (m.deprecated) {
        const flag = createEl('span');
        flag.className = 'ldiff-opt-flag';
        flag.textContent = 'deprecated';
        sub.appendChild(flag);
      }

      row.appendChild(main);
      row.appendChild(sub);
      return row;
    }

    function renderPickerButton() {
      safeClearHTML(pickerButton);
      const m = matches.find(x => x.matchKey === selectedMatchKey);
      if (!m) {
        pickerButton.textContent = 'No matches';
        return;
      }
      const row = buildOptionRow(m, 'selected');
      row.removeAttribute('role');
      row.removeAttribute('id');
      row.className = 'ldiff-opt ldiff-opt-current';
      pickerButton.appendChild(row);
      const caret = createEl('span');
      caret.className = 'ldiff-picker-caret';
      caret.setAttribute('aria-hidden', 'true');
      pickerButton.appendChild(caret);
    }

    function renderMatchOptions(preferredKey = null) {
      safeClearHTML(pickerList);

      const uniqueSources = new Set(matches.map(m => m.source || 'licensedb'));

      if (matches.length) {
        selectedMatchKey = (preferredKey && matches.some(m => m.matchKey === preferredKey))
          ? preferredKey
          : matches[0].matchKey;
      } else {
        selectedMatchKey = null;
      }

      let index = 0;
      const appendRow = (m) => pickerList.appendChild(buildOptionRow(m, index++));

      if (resultGroupingMode === 'bySource') {
        ['licensedb', 'spdx'].forEach((sourceKey) => {
          const sourceItems = matches.filter(m => (m.source || 'licensedb') === sourceKey);
          if (!sourceItems.length) return;
          const label = getSourceLabel(sourceKey);
          const group = createEl('div');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', label);
          const heading = createEl('div');
          heading.className = 'ldiff-opt-group';
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = label;
          group.appendChild(heading);
          sourceItems.forEach(m => group.appendChild(buildOptionRow(m, index++)));
          pickerList.appendChild(group);
        });
      } else {
        matches.forEach(appendRow);
      }

      setDisplay(groupingRow, (matches.length && uniqueSources.size > 1) ? 'flex' : 'none');
      renderPickerButton();
      syncActiveOption();
    }

    function syncActiveOption() {
      const nodes = getOptionNodes();
      nodes.forEach((node) => {
        const isSelected = node.getAttribute('data-key') === selectedMatchKey;
        node.setAttribute('aria-selected', String(isSelected));
        if (isSelected) addClass(node, 'is-selected');
        else removeClass(node, 'is-selected');
      });
      activeOptionIndex = nodes.findIndex(n => n.getAttribute('data-key') === selectedMatchKey);
      highlightActiveOption();
    }

    function highlightActiveOption(scroll = false) {
      const nodes = getOptionNodes();
      nodes.forEach(n => removeClass(n, 'is-active'));
      const node = nodes[activeOptionIndex];
      if (!node) {
        pickerButton.removeAttribute('aria-activedescendant');
        return;
      }
      addClass(node, 'is-active');
      pickerButton.setAttribute('aria-activedescendant', node.id);
      if (scroll) {
        try { node.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      }
    }

    const isPickerOpen = () => pickerButton.getAttribute('aria-expanded') === 'true';

    function openPicker() {
      if (!matches.length || isPickerOpen()) return;
      pickerButton.setAttribute('aria-expanded', 'true');
      setDisplay(pickerList, 'block');
      syncActiveOption();
      highlightActiveOption(true);
    }

    function closePicker(focusButton = false) {
      if (!isPickerOpen()) return;
      pickerButton.setAttribute('aria-expanded', 'false');
      setDisplay(pickerList, 'none');
      if (focusButton) { try { pickerButton.focus(); } catch { /* ignore */ } }
    }

    function selectMatch(key, { fire = true } = {}) {
      if (!key || !matches.some(m => m.matchKey === key)) return;
      selectedMatchKey = key;
      renderPickerButton();
      syncActiveOption();
      if (fire) onSelectionChange?.();
    }

    function moveActiveOption(step) {
      const nodes = getOptionNodes();
      if (!nodes.length) return;
      activeOptionIndex = activeOptionIndex < 0
        ? (step > 0 ? 0 : nodes.length - 1)
        : Math.min(nodes.length - 1, Math.max(0, activeOptionIndex + step));
      highlightActiveOption(true);
    }

    pickerButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isPickerOpen()) closePicker();
      else openPicker();
    });

    pickerButton.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isPickerOpen()) { openPicker(); return; }
        moveActiveOption(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        if (!isPickerOpen()) return;
        e.preventDefault();
        activeOptionIndex = e.key === 'Home' ? 0 : getOptionNodes().length - 1;
        highlightActiveOption(true);
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (!isPickerOpen()) return;
        e.preventDefault();
        const node = getOptionNodes()[activeOptionIndex];
        if (node) selectMatch(node.getAttribute('data-key'));
        closePicker(true);
      } else if (e.key === 'Escape' && isPickerOpen()) {
        e.preventDefault();
        e.stopPropagation();
        closePicker(true);
      }
    });

    pickerList.addEventListener('click', (e) => {
      const node = e.target?.closest?.('[role="option"]');
      if (!node) return;
      e.preventDefault();
      e.stopPropagation();
      selectMatch(node.getAttribute('data-key'));
      closePicker(true);
    });

    pickerList.addEventListener('mousemove', (e) => {
      const node = e.target?.closest?.('[role="option"]');
      if (!node) return;
      const nodes = getOptionNodes();
      const index = nodes.indexOf(node);
      if (index >= 0 && index !== activeOptionIndex) {
        activeOptionIndex = index;
        highlightActiveOption();
      }
    });

    document.addEventListener('click', (e) => {
      if (!isPickerOpen()) return;
      if (picker.contains?.(e.target)) return;
      closePicker();
    }, true);

    function prettyPercent(pStr) {
      if (pStr === undefined || pStr === null || pStr === '') return '';
      const num = parseFloat(pStr);
      if (isNaN(num)) return '';
      return `${num.toFixed(2)}%`;
    }

    const getSourceClass = (source) => (source === 'spdx' ? 'source-spdx' : 'source-licensedb');
    const getSourceLabel = (source) => (source === 'spdx' ? 'SPDX' : 'ScanCode');

    const escHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const escAttr = (value) => escHtml(value)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    function renderMetaPanel(match) {
      safeClearHTML(metaPanel);
      if (!match) {
        setDisplay(metaPanel, 'none');
        return;
      }

      const addChip = (label, value, className = '', description = '') => {
        if (!value) return;
        const chip = createEl('span');
        chip.className = `ldiff-metric${className ? ` ${className}` : ''}`;
        if (description) chip.title = description;
        const key = createEl('span');
        key.className = 'ldiff-metric-key';
        key.textContent = label;
        const val = createEl('span');
        val.className = 'ldiff-metric-val';
        val.textContent = value;
        chip.appendChild(key);
        chip.appendChild(val);
        metaPanel.appendChild(chip);
      };

      if (match.templateMatch) {
        const badge = createEl('span');
        badge.className = 'ldiff-metric ldiff-metric-flag';
        badge.textContent = 'Template match';
        badge.title = 'Matched the license template exactly, ignoring variable fields';
        metaPanel.appendChild(badge);
      }

      const metrics = match.diffMetrics || {};
      addChip('Score', prettyPercent(match.charSimilarity), 'ldiff-metric-primary');
      addChip('Containment', prettyPercent(metrics.containment), '', 'How much of the shorter text\u2019s vocabulary appears in the longer one. High containment with low word overlap usually means the license is embedded in a much larger document.');
      addChip('Cosine', prettyPercent(metrics.cosine), '', 'Similarity of the two texts\u2019 weighted word frequencies, ignoring word order');
      addChip('Token Lev.', prettyPercent(metrics.tokenLevenshtein), '', 'How few word-level edits are needed to turn one text into the other');

      setDisplay(metaPanel, metaPanel.childNodes.length ? 'flex' : 'none');
    }

    let changeAnchors = [];
    let currentChangeIndex = -1;

    const prefersReducedMotion = () => {
      try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
      catch { return false; }
    };

    const getDiffOutput = () => diffContainer.querySelector?.('.ldiff-output') || null;

    function updateChangeCounter() {
      const total = changeAnchors.length;
      if (!total) {
        changeCounter.textContent = 'No differences';
        return;
      }
      changeCounter.textContent = currentChangeIndex < 0
        ? `${total} change${total === 1 ? '' : 's'}`
        : `${currentChangeIndex + 1} / ${total}`;
    }

    function refreshDiffTools() {
      const output = getDiffOutput();
      changeAnchors = [];
      currentChangeIndex = -1;

      if (output) {
        const seen = new Set();
        output.querySelectorAll('[data-ldiff-change]').forEach((node) => {
          const id = node.getAttribute('data-ldiff-change');
          if (seen.has(id)) return;
          seen.add(id);
          changeAnchors.push(node);
        });
        if (foldToggle.getAttribute('aria-pressed') === 'true') addClass(output, 'ldiff-folded');
      }

      updateChangeCounter();
      setDisplay(diffToolbar, output ? 'flex' : 'none');
      prevChangeBtn.disabled = !changeAnchors.length;
      nextChangeBtn.disabled = !changeAnchors.length;
    }

    function gotoChange(step) {
      if (!changeAnchors.length) return;
      const total = changeAnchors.length;
      currentChangeIndex = currentChangeIndex < 0
        ? (step > 0 ? 0 : total - 1)
        : (currentChangeIndex + step + total) % total;

      const target = changeAnchors[currentChangeIndex];
      const id = target.getAttribute('data-ldiff-change');
      const output = getDiffOutput();
      output?.querySelectorAll('.ldiff-current').forEach(n => removeClass(n, 'ldiff-current'));
      output?.querySelectorAll(`[data-ldiff-change="${id}"]`).forEach(n => addClass(n, 'ldiff-current'));

      try {
        target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } catch {
        try { target.scrollIntoView(); } catch { /* ignore */ }
      }
      updateChangeCounter();
    }

    // Rebuilds the two source texts from the rendered diff, skipping fold placeholders.
    function extractDiffTexts() {
      const output = getDiffOutput();
      if (!output) return null;

      let reference = '';
      let selection = '';
      let marked = '';
      for (const node of Array.from(output.children)) {
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'ins') {
          selection += node.textContent;
          marked += `{+${node.textContent}+}`;
        } else if (tag === 'del') {
          reference += node.textContent;
          marked += `[-${node.textContent}-]`;
        } else {
          const parts = Array.from(node.children);
          const text = parts.length
            ? parts.filter(c => !hasClass(c, 'ldiff-ctx-fold')).map(c => c.textContent).join('')
            : node.textContent;
          reference += text;
          selection += text;
          marked += text;
        }
      }
      return { reference, selection, marked };
    }

    function copyToClipboard(text, successMessage) {
      if (!text) {
        showNotification('Nothing to copy', 'warning', 2000);
        return;
      }
      navigator.clipboard.writeText(text)
        .then(() => showNotification(successMessage, 'success', 2000))
        .catch((err) => {
          console.error('Clipboard write failed:', err);
          showNotification('Failed to copy to clipboard', 'error');
        });
    }

    prevChangeBtn.addEventListener('click', () => gotoChange(-1));
    nextChangeBtn.addEventListener('click', () => gotoChange(1));

    foldToggle.addEventListener('click', () => {
      const next = foldToggle.getAttribute('aria-pressed') !== 'true';
      foldToggle.setAttribute('aria-pressed', String(next));
      const output = getDiffOutput();
      if (!output) return;
      if (next) addClass(output, 'ldiff-folded');
      else removeClass(output, 'ldiff-folded');
    });

    copyDiffBtn.addEventListener('click', () => {
      // [-removed-] / {+added+} markers keep the diff readable as plain text.
      copyToClipboard(extractDiffTexts()?.marked || '', 'Diff copied to clipboard');
    });

    copyRefBtn.addEventListener('click', () => {
      copyToClipboard(extractDiffTexts()?.reference || '', 'Reference license copied to clipboard');
    });

    document.addEventListener('keydown', (e) => {
      if ((uiContainer.style?.display || '') !== 'flex') return;
      if (!uiContainer.contains?.(document.activeElement)) return;
      if (e.key === 'Escape') {
        setDisplay(uiContainer, 'none');
        return;
      }
      if (!changeAnchors.length) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); gotoChange(1); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoChange(-1); }
    });


    function showNotification(message, type = 'info', duration = 5000) {
      ensureMounted();

      const notification = createEl('div');
      notification.className = `license-diff-notification ${type}`;
      notification.textContent = message;

      notificationsContainer.appendChild(notification);

      if ((uiContainer.style?.display || '') !== 'flex') setDisplay(uiContainer, 'flex');

      try {
        notification.scrollIntoView?.({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'center'
        });
      } catch { /* ignore */ }

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
    getResultGroupingMode().then(mode => {
      resultGroupingMode = mode;
      groupingSelect.value = mode;
    });

    themeSelect.addEventListener('change', () => {
      const theme = themeSelect.value === 'dark' ? 'dark' : 'light';
      applyThemeClass(theme);
      saveTheme(theme);
    });

    groupingSelect.addEventListener('change', () => {
      resultGroupingMode = groupingSelect.value === 'bySource' ? 'bySource' : 'overall';
      try { ext.storage?.sync?.set({ resultGrouping: resultGroupingMode }); } catch { /* ignore */ }

      if (!matches.length) return;
      renderMatchOptions(selectedMatchKey);
      onSelectionChange?.();
    });

    try {
      ext.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'sync') {
          if (changes.theme) {
            const theme = changes.theme.newValue === 'dark' ? 'dark' : 'light';
            applyThemeClass(theme);
            themeSelect.value = theme;
          }
          if (changes.resultGrouping) {
            resultGroupingMode = changes.resultGrouping.newValue === 'bySource' ? 'bySource' : 'overall';
            groupingSelect.value = resultGroupingMode;
            if (matches.length) {
              renderMatchOptions(selectedMatchKey);
              onSelectionChange?.();
            }
          }
        }
      });
    } catch { /* ignore */ }

    ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
          closePicker();
          safeClearHTML(pickerList);
          safeClearHTML(pickerButton);
          setDisplay(picker, 'none');
          selectedMatchKey = null;
          activeOptionIndex = -1;

          setDisplay(linkDisplay, 'none');
          safeClearHTML(linkDisplay);

          setDisplay(diffContainer, 'none');
          safeClearHTML(diffContainer);

          setDisplay(metaPanel, 'none');
          safeClearHTML(metaPanel);

          setDisplay(diffToolbar, 'none');
          changeAnchors = [];
          currentChangeIndex = -1;

          setDisplay(groupingRow, 'none');

          if (progressEl) {
            removeClass(progressEl, 'animating');
            addClass(progressEl, 'no-transition');
            setStyleProp(progressEl, 'width', '0%');
            try { void progressEl.offsetWidth; } catch { /* ignore */ }
            removeClass(progressEl, 'no-transition');
          }

          setDisplay(status, 'block');
          setDisplay(progressBar, 'block');
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

          const progressMsg = (message.progress && typeof message.progress.message === 'string') ? message.progress.message : '';
          if (progressMsg && checked >= total) {
            // After the approx phase completes, surface the refinement / completion message
            // so the UI doesn't appear stuck on "Checked X of X licenses...".
            status.textContent = progressMsg;
          } else {
            status.textContent = `Checked ${checked} of ${total} licenses...`;
          }
          sendResponse({ success: true });
        } else if (message.action === 'showResults') {
          removeClass(progressEl, 'animating');

          matches = Array.isArray(message.matches) ? message.matches : [];
          safeClearHTML(pickerList);

          matches.forEach(m => {
            const matchKey = `${m.source || 'licensedb'}:${m.license}`;
            m.matchKey = matchKey;
            const targetUrl = m.link || `https://scancode-licensedb.aboutcode.org/${m.license}.html`;
            const sourceLabel = getSourceLabel(m.source);
            m.sourceLabel = sourceLabel;

            m.link = `<a href="${escAttr(targetUrl)}" target="_blank">${escHtml(m.name)}</a>
              <span class="source-badge ${getSourceClass(m.source)}">${escHtml(sourceLabel)}</span>
              ${m.deprecated ? '<span class="deprecated-badge">deprecated</span>' : ''}
              <span class="spdx-container">
                <span class="spdx-id">(${escHtml(m.spdx)})</span>
                <button class="copy-spdx-button" data-spdx="${escAttr(m.spdx)}" title="Copy identifier" aria-label="Copy identifier ${escAttr(m.spdx)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </span>`;
          });

          renderMatchOptions();

          onSelectionChange = () => {
            const sel = matches.find(m => m.matchKey === selectedMatchKey);
            if (!sel) return;

            safeSetHTML(linkDisplay, sel.link);

            const a = linkDisplay.querySelector?.('a');
            if (a) {
              a.setAttribute('rel', 'noopener noreferrer');
              a.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                ext.runtime.sendMessage({ action: 'openExternal', url: a.href });
              }, { passive: false });
            }

            renderMetaPanel(sel);

            safeSetHTML(diffContainer, sel.diff !== null
              ? sel.diff
              : '<div class="ldiff-pending">Generating diff\u2026</div>');
            refreshDiffTools();
            updateDiffSizing();
            setupCopyButtons();
          };

          setDisplay(picker, 'block');
          setDisplay(linkDisplay, 'block');
          setDisplay(diffContainer, 'block');

          if (matches.length) {
            onSelectionChange();
          }

          const hasPendingDiffs = matches.some(m => m.diff === null);
          if (hasPendingDiffs) {
            status.textContent = 'Results ready. Generating diffs...';
          } else {
            setDisplay(status, 'none');
            setDisplay(progressBar, 'none');
          }
          updateDiffSizing();
          sendResponse({ success: true });
        } else if (message.action === 'updateMatchDiff') {
          const match = matches.find(m => m.matchKey === message.matchKey);
          if (match) {
            match.diff = message.diff;
            // If this match is currently selected, refresh its diff view
            if (selectedMatchKey === message.matchKey) {
              safeSetHTML(diffContainer, match.diff !== null
                ? match.diff
                : '<div class="ldiff-pending">Generating diff\u2026</div>');
              refreshDiffTools();
              updateDiffSizing();
            }
            // Hide status and progress bar when all diffs have arrived
            if (matches.every(m => m.diff !== null)) {
              setDisplay(status, 'none');
              setDisplay(progressBar, 'none');
            }
          }
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
      // Scoped to the link row and guarded so re-renders don't stack listeners.
      linkDisplay.querySelectorAll?.('.copy-spdx-button:not([data-ldiff-bound])').forEach(button => {
        button.setAttribute('data-ldiff-bound', '1');
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
      ext.runtime.sendMessage({ action: 'contentScriptReady' });
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

