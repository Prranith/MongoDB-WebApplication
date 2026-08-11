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

  // Track workspace changes and sync to tab state (with local auto-save to browser cache)
  editor.on('change', () => {
    if (S.activeFile) {
      const file = S.files.find(f => f.path === S.activeFile);
      if (file) {
        const val = editor.getValue();
        if (file.content !== val) {
          file.content = val;
          localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
        }
        // Remove dirty dot since it is auto-saved
        const tabEl = document.getElementById(`tab-${escId(S.activeFile)}`);
        if (tabEl) tabEl.classList.remove('dirty');
      }
    }
  });

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
