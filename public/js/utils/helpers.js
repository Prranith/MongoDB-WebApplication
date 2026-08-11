// ═══════════════════════════════════════════════════════════════════
// HTML FORMAT ESCAPER
// ═══════════════════════════════════════════════════════════════════
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escId(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '_');
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS OPERATIONS
// ═══════════════════════════════════════════════════════════════════
function loadSettingsFromLocalStorage() {
  const defaults = {
    fontFamily: 'Consolas',
    fontSizeVal: 11,
    fontSizeUnit: 'pt',
    tabWidth: '4 spaces',
    maxResults: 10000,
    timeout: '30 s'
  };
  const saved = JSON.parse(localStorage.getItem('mongosandbox_settings') || '{}');
  S.settings = { ...defaults, ...saved };
  
  // Backwards compatibility for old S.settings.fontSize (e.g. "13 pt")
  if (saved.fontSize && !saved.fontSizeVal) {
    const valMatch = String(saved.fontSize).match(/\d+/);
    const unitMatch = String(saved.fontSize).match(/[a-zA-Z]+/);
    S.settings.fontSizeVal = valMatch ? parseInt(valMatch[0]) : 13;
    S.settings.fontSizeUnit = unitMatch ? unitMatch[0] : 'pt';
  }
  
  // Populate modal inputs
  document.getElementById('set-font-family').value = S.settings.fontFamily;
  document.getElementById('set-font-size-val').value = S.settings.fontSizeVal;
  document.getElementById('set-font-size-unit').value = S.settings.fontSizeUnit;
  document.getElementById('set-tab-width').value = S.settings.tabWidth;
  document.getElementById('set-max-results').value = S.settings.maxResults;
  document.getElementById('set-timeout').value = S.settings.timeout;
}

function saveSettings() {
  S.settings.fontFamily = document.getElementById('set-font-family').value;
  S.settings.fontSizeVal = parseInt(document.getElementById('set-font-size-val').value) || 11;
  S.settings.fontSizeUnit = document.getElementById('set-font-size-unit').value;
  S.settings.tabWidth = document.getElementById('set-tab-width').value;
  S.settings.maxResults = parseInt(document.getElementById('set-max-results').value) || 10000;
  S.settings.timeout = document.getElementById('set-timeout').value;
  
  // Maintain S.settings.fontSize for older dependencies
  S.settings.fontSize = S.settings.fontSizeVal + S.settings.fontSizeUnit;
  
  localStorage.setItem('mongosandbox_settings', JSON.stringify(S.settings));
  applySettings();
  closeModal('settings-modal');
  logOutput('[info] Editor and execution settings saved.');
}

function applySettings() {
  if (!editor) return;
  
  // Extract number from tabWidth (e.g. "4 spaces" -> 4)
  const tabMatch = String(S.settings.tabWidth || '4').match(/\d+/);
  const tabVal = tabMatch ? parseInt(tabMatch[0]) : 4;
  editor.setOption('tabSize', tabVal);
  editor.setOption('indentUnit', tabVal);
  
  // Apply styling dynamically (fontFamily, fontSize)
  let styleEl = document.getElementById('cm-dyn-settings-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cm-dyn-settings-style';
    document.head.appendChild(styleEl);
  }
  
  const sizeVal = (S.settings.fontSizeVal || 11) + (S.settings.fontSizeUnit || 'pt');
  
  styleEl.textContent = `
    .CodeMirror,
    .CodeMirror pre.CodeMirror-line,
    .CodeMirror pre.CodeMirror-line-like,
    .CodeMirror-linenumber,
    .CodeMirror-lines * {
      font-family: ${S.settings.fontFamily || 'Consolas'}, 'JetBrains Mono', monospace !important;
      font-size: ${sizeVal} !important;
    }
  `;
  editor.refresh();
}
