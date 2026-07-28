// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  // Initialize settings
  loadSettingsFromLocalStorage();

  // Initialize state from local storage fallback
  loadHistoryFromLocalStorage();

  // Setup CodeMirror IntelliSense Helper
  setupMongoIntelliSense();

  const tabVal = parseInt(S.settings.tabWidth) || 8;

  // Setup CodeMirror
  editor = CodeMirror.fromTextArea(document.getElementById('raw-editor'), {
    mode: 'javascript',
    theme: 'default',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: tabVal,
    tabSize: tabVal,
    styleActiveLine: true,
    extraKeys: {
      'Ctrl-Enter': runQuery,
      'Cmd-Enter': runQuery,
      'Ctrl-/': cm => cm.execCommand('toggleComment'),
      'Alt-F': formatQuery,
      'Ctrl-S': cm => { saveQuery(); },
      'Ctrl-Space': cm => { cm.showHint({ hint: CodeMirror.hint.javascript, completeSingle: false }); },
    },
  });
  editor.setSize('100%', '100%');

  // Trigger IntelliSense autocompletion as user types
  editor.on('inputRead', (cm, change) => {
    if (change.text[0] === '.' || change.text[0] === '$' || (change.text[0].length === 1 && change.text[0].match(/[a-zA-Z]/))) {
      cm.showHint({ hint: CodeMirror.hint.javascript, completeSingle: false });
    }
  });

  // Track cursor position
  editor.on('cursorActivity', () => {
    const c = editor.getCursor();
    document.getElementById('sb-pos').textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
  });

  // Track workspace changes and sync to tab state
  editor.on('change', () => {
    if (S.activeFile) {
      const file = S.files.find(f => f.path === S.activeFile);
      if (file) {
        const val = editor.getValue().replace(/\r\n/g, '\n');
        const fileContent = file.content.replace(/\r\n/g, '\n');
        if (fileContent !== val) {
          document.getElementById(`tab-${escId(S.activeFile)}`)?.classList.add('dirty');
        } else {
          document.getElementById(`tab-${escId(S.activeFile)}`)?.classList.remove('dirty');
        }
      }
    }
  });

  // Apply visual theme override
  applyEditorTheme();
  applySettings();
  initResizer();
  initConsoleResizer();

  // Load backend metrics & explorer data
  loadFiles();
  loadCollections();
  loadSnippets();
  recordLaunch();

  // Setup Global Keyboard Shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveQuery(); }
    if (e.key === 'Escape') { closePalette(); closeAllModals(); closeMenus(); }
    if (e.key === 'F1') { e.preventDefault(); openModal('schema-modal'); }
  });

  document.addEventListener('click', closeMenus);
});

// Apply VS Code dark theme style tokens directly
function applyEditorTheme() {
  const style = document.createElement('style');
  style.textContent = `
    .CodeMirror { background:#1e1e1e !important; color:#d4d4d4 !important; }
    .CodeMirror-gutters { background:#1e1e1e !important; border-right:1px solid #3c3c3c !important; }
    .CodeMirror-linenumber { color:#858585 !important; }
    .CodeMirror-activeline-background { background:#282828 !important; }
    .CodeMirror-selected { background:#264f78 !important; }
    .CodeMirror-cursor { border-left:2px solid #aeafad !important; }
    .cm-keyword { color:#569cd6 !important; }
    .cm-string, .cm-string-2 { color:#ce9178 !important; }
    .cm-number { color:#b5cea8 !important; }
    .cm-comment { color:#6a9955 !important; font-style:italic; }
    .cm-property { color:#9cdcfe !important; }
    .cm-variable { color:#9cdcfe !important; }
    .cm-variable-2 { color:#9cdcfe !important; }
    .cm-def { color:#dcdcaa !important; }
    .cm-operator { color:#d4d4d4 !important; }
    .cm-atom { color:#569cd6 !important; }
    .cm-punctuation { color:#d4d4d4 !important; }
    .CodeMirror-scroll { background:#1e1e1e !important; }
    .CodeMirror-hints { background:#252526; border:1px solid #454545; z-index:1000; }
    .CodeMirror-hint { color:#d4d4d4; }
    .CodeMirror-hint-active { background:#094771 !important; color:#fff; }
    .tab.dirty .tab-dot { display: block !important; }
  `;
  document.head.appendChild(style);
}
