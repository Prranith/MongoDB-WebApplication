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
      // The browser must not treat the IDE shortcut as “close tab”.
      'Ctrl-W': () => {},
      'Cmd-W': () => {},
    },
  });
  editor.setSize('100%', '100%');
  attachCodexaKeywordHints(editor, () => {
    const select = document.getElementById('workspace-lang-select');
    return select ? select.value : 'mongodb';
  });

  // Trigger IntelliSense autocompletion as user types
  editor.on('inputRead', (cm, change) => {
    const lang = document.getElementById('workspace-lang-select')?.value || 'mongodb';
    if (lang !== 'mongodb') return;
    if (change.text[0] === '.' || change.text[0] === '$' || (change.text[0].length === 1 && change.text[0].match(/[a-zA-Z]/))) {
      cm.showHint({ hint: CodeMirror.hint.javascript, completeSingle: false });
    }
  });

  // Track cursor position
  editor.on('cursorActivity', () => {
    const c = editor.getCursor();
    document.getElementById('sb-pos').textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
  });

  // Track workspace changes and persist to the selected local folder when one
  // is connected. The browser-storage fallback remains available elsewhere.
  editor.on('change', () => {
    if (S.activeFile) {
      const file = S.files.find(f => f.path === S.activeFile);
      if (file) {
        const val = editor.getValue();
        if (file.content !== val) {
          file.content = val;
          if (typeof persistBrowserWorkspace === 'function') persistBrowserWorkspace();
          if (typeof scheduleWorkspaceFileWrite === 'function') scheduleWorkspaceFileWrite(file);
        }
        // Remove dirty dot since it is auto-saved
        const tabEl = document.getElementById(`tab-${escId(S.activeFile)}`);
        if (tabEl) tabEl.classList.remove('dirty');
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
  window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    const previewOpen = document.getElementById('workspace-file-preview')?.classList.contains('active');
    if (previewOpen && !e.altKey && !e.shiftKey) {
      if (key === '+' || key === '=') {
        e.preventDefault(); e.stopImmediatePropagation(); changeWorkspacePreviewZoom(0.25); return;
      }
      if (key === '-' || key === '_') {
        e.preventDefault(); e.stopImmediatePropagation(); changeWorkspacePreviewZoom(-0.25); return;
      }
      if (key === '0') {
        e.preventDefault(); e.stopImmediatePropagation(); resetWorkspacePreviewTransform(); return;
      }
      if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation(); rotateWorkspacePreview(90); return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && ['r', 't', 'w', 'n', 'l'].includes(key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'F5') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }, true);
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
