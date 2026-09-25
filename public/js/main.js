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
    // Local VS Code-style fold gutter. This does not depend on a CDN addon.
    gutters: ['CodeMirror-linenumbers', 'codexa-fold-gutter'],
    extraKeys: {
      'Ctrl-Enter': runQuery,
      'Cmd-Enter': runQuery,
      'Ctrl-/': toggleCommentWithIndent,
      'Alt-F': formatQuery,
      'Ctrl-S': cm => { saveQuery(); },
      'Ctrl-Space': cm => { cm.showHint({ hint: CodeMirror.hint.javascript, completeSingle: false }); },
      // The browser must not treat the IDE shortcut as “close tab”.
      'Ctrl-W': () => {},
      'Cmd-W': () => {},
    },
  });
  editor.setSize('100%', '100%');
  initializeCodexaFolding(editor);
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
    if (window.__codexaEditorShareApplying) return;
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

// Keep toggled comments aligned with the selected code block. The generic
// CodeMirror command can place markers at column zero for mixed indentation.
function toggleCommentWithIndent(cm) {
  const mode = String(cm.getOption('mode') || '').toLowerCase();
  const marker = mode.includes('python') ? '# ' : mode.includes('sql') ? '-- ' : '// ';
  const selections = cm.listSelections();

  cm.operation(() => {
    selections.forEach(selection => {
      const start = Math.min(selection.anchor.line, selection.head.line);
      const end = Math.max(selection.anchor.line, selection.head.line);
      const lines = [];
      for (let line = start; line <= end; line += 1) lines.push(cm.getLine(line));
      const nonBlank = lines.filter(line => line.trim());
      if (!nonBlank.length) return;

      const isCommented = nonBlank.every(line =>
        /^(\s*)(?:(?:\/\/)|(?:#)|(?:--))(?:\s|$)/.test(line)
      );

      for (let line = start; line <= end; line += 1) {
        const value = cm.getLine(line);
        if (!value.trim()) continue;
        if (isCommented) {
          const uncommented = value.replace(/^(\s*)(?:(?:\/\/)|(?:#)|(?:--))\s?/, '$1');
          cm.replaceRange(uncommented, { line, ch: 0 }, { line, ch: value.length });
        } else {
          const match = value.match(/^(\s*)/);
          cm.replaceRange(marker, { line, ch: match[1].length });
        }
      }
    });
  });
}

// Local VS Code-style folding for the main editor. This keeps the fold gutter
// available even when a third-party CodeMirror addon CDN is unavailable.
function initializeCodexaFolding(cm) {
  const gutterName = 'codexa-fold-gutter';
  const foldedRanges = new Map();
  let marks = new Map();
  let refreshing = false;

  function indentation(line) {
    const match = line.match(/^\s*/);
    return match ? match[0].replace(/\t/g, ' '.repeat(cm.getOption('tabSize') || 4)).length : 0;
  }

  function braceRange(startLine) {
    const first = cm.getLine(startLine);
    const braceIndex = first.indexOf('{');
    if (braceIndex < 0 || first.slice(braceIndex + 1).trim()) return null;
    const header = first.slice(0, braceIndex).trim();
    const blockKeyword = /^(?:class|struct|union|namespace|enum|if|else|for|while|switch|catch|try|do)\b/.test(header);
    const callable = /\)\s*$/.test(header);
    if (!blockKeyword && !callable) return null;
    let depth = 0;
    for (let line = startLine; line < cm.lineCount(); line += 1) {
      const value = cm.getLine(line);
      for (const char of value) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
      }
      if (depth === 0 && line > startLine) {
        const closingLine = cm.getLine(line);
        return {
          start: startLine,
          startCh: braceIndex + 1,
          end: line,
          endCh: closingLine.search(/\S|$/)
        };
      }
    }
    return null;
  }

  function indentationRange(startLine) {
    const mode = String(cm.getOption('mode') || '').toLowerCase();
    if (!mode.includes('python')) return null;
    const first = cm.getLine(startLine);
    if (!first.trim() || /[{]/.test(first)) return null;
    const base = indentation(first);
    let end = startLine;
    let foundChild = false;
    for (let line = startLine + 1; line < cm.lineCount(); line += 1) {
      const value = cm.getLine(line);
      if (!value.trim()) {
        if (foundChild) end = line;
        continue;
      }
      if (indentation(value) <= base) break;
      foundChild = true;
      end = line;
    }
    return foundChild && end > startLine ? { start: startLine, startCh: first.length, end, endCh: 0 } : null;
  }

  function rangeForLine(line) {
    return braceRange(line) || indentationRange(line);
  }

  function marker(text, folded, placeholder) {
    const node = document.createElement('span');
    node.className = 'codexa-fold-marker ' + (folded ? 'is-folded' : 'is-open') + (placeholder ? ' codexa-fold-placeholder' : '');
    node.textContent = text;
    node.title = folded ? 'Expand section' : 'Collapse section';
    return node;
  }

  function refresh() {
    if (refreshing) return;
    refreshing = true;
    marks.forEach(mark => mark.clear());
    marks = new Map();
    for (let line = 0; line < cm.lineCount(); line += 1) {
      const range = rangeForLine(line);
      if (!range) {
        cm.setGutterMarker(line, gutterName, null);
        continue;
      }
      const key = range.start + ':' + range.end;
      const isFolded = foldedRanges.has(key);
      cm.setGutterMarker(line, gutterName, marker(isFolded ? '>' : 'v', isFolded));
      if (isFolded) {
        const mark = cm.markText(
          { line: range.start, ch: range.startCh },
          { line: range.end, ch: range.endCh },
          { collapsed: true, clearWhenEmpty: false, replacedWith: marker('...', true, true) }
        );
        marks.set(key, mark);
      }
    }
    refreshing = false;
  }

  function toggle(line) {
    const range = rangeForLine(line);
    if (!range) return;
    const key = range.start + ':' + range.end;
    if (foldedRanges.has(key)) foldedRanges.delete(key);
    else foldedRanges.set(key, range);
    refresh();
  }

  cm.on('gutterClick', (instance, line, gutter) => {
    if (gutter === gutterName) toggle(line);
  });
  cm.on('change', refresh);
  cm._codexaFolding = { refresh, toggle };
  refresh();
}

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
