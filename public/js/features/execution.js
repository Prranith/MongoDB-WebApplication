// ═══════════════════════════════════════════════════════════════════
// EXECUTE QUERY RUNNER
// ═══════════════════════════════════════════════════════════════════
async function runQuery() {
  const langSelect = document.getElementById('workspace-lang-select');
  const lang = langSelect ? langSelect.value : 'mongodb';
  if (lang !== 'mongodb') {
    const consoleEl = document.getElementById('terminal-interactive-console');
    let stdin = '';
    if (consoleEl) {
      const fullText = consoleEl.value;
      const parts = fullText.split('================= Output =================');
      stdin = parts[0].trim();
    }
    await runPlaygroundCode(lang, editor.getValue(), stdin);
    return;
  }

  const q = editor.getValue().trim();
  if (!q) return;

  const statEl = document.getElementById('console-status');
  if (statEl) statEl.innerHTML = `⟳ Running query...`;
  
  const timeEl = document.getElementById('console-time');
  const countEl = document.getElementById('console-count');
  if (timeEl) timeEl.textContent = '0ms';
  if (countEl) countEl.textContent = '0 docs';

  logOutput(`<span class="out-info">[info] Executing MongoDB command...</span>`);
  
  const runBtn = document.querySelector('.tbtn-run');
  runBtn.classList.add('running');
  runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Stop`;

  try {
    const limitVal = S.settings ? S.settings.maxResults : 10000;
    // Filter custom collections to only include those referenced in the query string
    const customCollsMap = {};
    try {
      const stored = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
      Object.entries(stored).forEach(([name, docs]) => {
        const pattern = new RegExp('\\b' + name + '\\b');
        if (pattern.test(q)) {
          customCollsMap[name] = docs;
        }
      });
    } catch(e) {}

    const d = await fetchAPI('/api/query', {
      method: 'POST',
      body: JSON.stringify({ 
        query: q, 
        limit: limitVal,
        custom_collections: customCollsMap
      })
    });
    
    S.lastData = d.data;
    S.lastRaw = JSON.stringify(d.data, null, 2);
    
    runBtn.classList.remove('running');
    runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;

    const ms = (d.timing_ms || 0).toFixed(2);
    const count = d.docs_returned || 0;

    if (d.status === 'ok' || d.status === 'empty') {
      if (statEl) statEl.innerHTML = `✓ ${count} document(s) returned`;
      if (timeEl) timeEl.textContent = `${ms}ms`;
      if (countEl) countEl.textContent = `${count} docs`;

      document.getElementById('sb-timing').textContent = `${ms}ms`;
      document.getElementById('sb-docs').textContent = `${count} docs`;
      
      logOutput(`<span class="out-ok">[success] Evaluated ${count} document(s) in ${ms}ms.</span>`);
      
      const arr = Array.isArray(d.data) ? d.data : (d.data !== null ? [d.data] : []);
      renderTreeView(arr);
      renderRawJsonView(arr);
      
      // Save query execution to history state
      saveToHistory(q, d.status, count, d.timing_ms);
    } else {
      if (statEl) statEl.innerHTML = `— Query Error`;
      if (timeEl) timeEl.textContent = `0ms`;
      if (countEl) countEl.textContent = `0 docs`;
      logOutput(`<span class="out-err">[error] ${esc(d.error || 'Unknown evaluation error')}</span>`);
      if (d.traceback_str) {
        logOutput(`<span class="out-info">${esc(d.traceback_str)}</span>`);
      }
      renderTreeView([]);
      renderRawJsonView(null);
      saveToHistory(q, 'error', 0, 0);
    }
  } catch(e) {
    runBtn.classList.remove('running');
    runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;
    if (statEl) statEl.innerHTML = `— Network Error`;
    logOutput(`<span class="out-err">[network error] ${esc(e.message)}</span>`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RESULT COLLAPSIBLE TREE RENDERER (Recursive QTreeWidget look)
// ═══════════════════════════════════════════════════════════════════
function jsBuildTreeNodes(data, key = "root") {
  if (data === null || data === undefined) {
    return { key, value: "null", type: "null", children: [] };
  }
  if (typeof data === "object") {
    if (data["$oid"] !== undefined) {
      return { key, value: `ObjectId("${data["$oid"]}")`, type: "objectid", children: [] };
    }
    if (data["$date"] !== undefined) {
      let d = new Date(data["$date"]);
      return { key, value: d.toISOString(), type: "date", children: [] };
    }
    if (Array.isArray(data)) {
      return {
        key,
        value: `Array [${data.length} items]`,
        type: "array",
        children: data.map((item, i) => jsBuildTreeNodes(item, `[${i}]`))
      };
    }
    return {
      key,
      value: `Object {${Object.keys(data).length} fields}`,
      type: "object",
      children: Object.entries(data).map(([k, v]) => jsBuildTreeNodes(v, k))
    };
  }
  if (typeof data === "boolean") {
    return { key, value: String(data), type: "boolean", children: [] };
  }
  if (typeof data === "number") {
    return { key, value: String(data), type: "number", children: [] };
  }
  if (typeof data === "string") {
    return { key, value: `"${data}"`, type: "string", children: [] };
  }
  return { key, value: String(data), type: "unknown", children: [] };
}

function buildTreeHtml(node, depth = 0) {
  const children = node.children || [];
  const hasChildren = children.length > 0;
  const icon = _TYPE_ICONS[node.type] || node.type;
  const color = _TYPE_COLORS[node.type] || '';
  
  const indent = depth * 16;
  const toggle = hasChildren ? `<span class="tree-toggle-arrow">▶</span>` : `<span class="tree-toggle-spacer"></span>`;
  
  let childrenHtml = '';
  if (hasChildren) {
    childrenHtml = `
      <div class="tree-node-children" style="display:none">
        ${children.map(child => buildTreeHtml(child, depth + 1)).join('')}
      </div>
    `;
  }
  
  return `
    <div class="tree-node-container ${hasChildren ? 'has-children' : ''}">
      <div class="tree-node-row" onclick="handleTreeNodeClick(this, event)">
        <div class="tree-node-col tree-node-key" style="padding-left: ${indent}px;">
          ${toggle}
          <span class="tree-node-key-text">${esc(node.key)}</span>
        </div>
        <div class="tree-node-col tree-node-value ${node.type}" style="color:${color}">
          ${esc(node.value)}
        </div>
        <div class="tree-node-col tree-node-type">
          ${icon}
        </div>
      </div>
      ${childrenHtml}
    </div>
  `;
}

function handleTreeNodeClick(rowEl, event) {
  event.stopPropagation();
  const container = rowEl.closest('.tree-node-container');
  if (!container.classList.contains('has-children')) return;
  
  const childrenDiv = container.querySelector(':scope > .tree-node-children');
  const arrow = rowEl.querySelector('.tree-toggle-arrow');
  
  if (childrenDiv.style.display === 'none') {
    childrenDiv.style.display = 'block';
    arrow.classList.add('expanded');
  } else {
    childrenDiv.style.display = 'none';
    arrow.classList.remove('expanded');
  }
}

function renderTreeView(dataList) {
  const container = document.getElementById('tree-rows');
  if (!dataList || !dataList.length) {
    container.innerHTML = `<div style="padding:12px 14px;color:var(--text3);font-family:'JetBrains Mono',monospace">// Empty result</div>`;
    return;
  }
  
  const nodes = dataList.map((doc, i) => jsBuildTreeNodes(doc, `[${i}]`));
  container.innerHTML = nodes.map(node => buildTreeHtml(node)).join('');
  
  // Auto expand top level documents
  document.querySelectorAll('#tree-rows > .tree-node-container').forEach((el, i) => {
    if (i < 3) {
      const row = el.querySelector('.tree-node-row');
      if (row) handleTreeNodeClick(row, { stopPropagation: () => {} });
    }
  });
}

function toggleExpandAllTreeNodes() {
  const allContainers = document.querySelectorAll('.tree-node-container.has-children');
  const btn = document.getElementById('vbtn-out');
  const isExpand = btn.textContent === 'Expand All';
  
  allContainers.forEach(container => {
    const childrenDiv = container.querySelector(':scope > .tree-node-children');
    const arrow = container.querySelector('.tree-toggle-arrow');
    if (isExpand) {
      childrenDiv.style.display = 'block';
      arrow.classList.add('expanded');
    } else {
      childrenDiv.style.display = 'none';
      arrow.classList.remove('expanded');
    }
  });
  
  btn.textContent = isExpand ? 'Collapse All' : 'Expand All';
}

function renderRawJsonView(data) {
  const container = document.getElementById('raw-view');
  if (!data) {
    container.innerHTML = `<div style="padding:12px 14px;color:var(--text3);font-family:'JetBrains Mono',monospace">// Empty</div>`;
    return;
  }
  const str = JSON.stringify(data, null, 2);
  container.innerHTML = `
    <pre style="margin:0;font-family:inherit">${syntaxHighlightJSON(str)}</pre>
  `;
}

function syntaxHighlightJSON(str) {
  return esc(str)
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="json-str">"$1"</span>')
    .replace(/: (true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/: (null)/g, ': <span class="json-null">$1</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="json-num">$1</span>');
}

// ═══════════════════════════════════════════════════════════════════
// CONSOLE LOGS & STATUS
// ═══════════════════════════════════════════════════════════════════
function setConsoleStatus(text) {
  document.getElementById('console-status').textContent = text;
}

function logOutput(html) {
  const outView = document.getElementById('output-text');
  outView.innerHTML += `\n` + html;
  outView.scrollTop = outView.scrollHeight;
}

function setConTab(tab) {
  S.conTab = tab;
  const langSelect = document.getElementById('workspace-lang-select');
  const lang = langSelect ? langSelect.value : 'mongodb';
  const isMongo = lang === 'mongodb';

  ['output', 'logs', 'stdin'].forEach(function(t) {
    const el = document.getElementById(`ctab-${t}`);
    if (el) el.classList.toggle('active', t === tab);
  });
  
  const treeView = document.getElementById('tree-view');
  const rawView = document.getElementById('raw-view');
  const outputView = document.getElementById('output-view');
  const terminalView = document.getElementById('terminal-view');
  const viewBtns = document.getElementById('view-btns');
  
  if (isMongo) {
    const showOutput = tab === 'output';
    if (treeView) treeView.style.display = (showOutput && S.resultView === 'tree') ? 'flex' : 'none';
    if (rawView) rawView.style.display = (showOutput && S.resultView === 'raw') ? 'block' : 'none';
    if (outputView) outputView.style.display = (!showOutput || S.resultView === 'out') ? 'block' : 'none';
    if (terminalView) terminalView.style.display = 'none';
    if (viewBtns) viewBtns.style.display = showOutput ? 'flex' : 'none';
  } else {
    if (treeView) treeView.style.display = 'none';
    if (rawView) rawView.style.display = 'none';
    if (viewBtns) viewBtns.style.display = 'none';
    
    if (tab === 'stdin') {
      if (outputView) outputView.style.display = 'none';
      if (terminalView) terminalView.style.display = 'flex';
    } else {
      if (outputView) outputView.style.display = 'block';
      if (terminalView) terminalView.style.display = 'none';
    }
  }
}

function setResultView(mode) {
  if (mode === 'out') {
    toggleExpandAllTreeNodes();
    return;
  }
  S.resultView = mode;
  ['tree', 'raw'].forEach(t => {
    document.getElementById(`vbtn-${t}`).classList.toggle('active-view', t === mode);
  });
  setConTab(S.conTab);
}

function clearConsole() {
  document.getElementById('tree-rows').innerHTML = `<div style="padding:12px 14px;color:var(--text3);font-family:'JetBrains Mono',monospace">// Cleared</div>`;
  document.getElementById('raw-view').innerHTML = `<div style="padding:12px 14px;color:var(--text3);font-family:'JetBrains Mono',monospace">// Cleared</div>`;
  document.getElementById('output-text').innerHTML = `<span class="out-info">// Console cleared</span>`;
  const termConsole = document.getElementById('terminal-interactive-console');
  if (termConsole) {
    termConsole.value = '';
  }
  setConsoleStatus('— Ready');
}

function copyResult() {
  const text = S.lastRaw || '';
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      setConsoleStatus('— Result Copied!');
      setTimeout(() => setConsoleStatus('— Ready'), 1500);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// HISTORY ENGINE (Local Storage)
// ═══════════════════════════════════════════════════════════════════
function loadHistoryFromLocalStorage() {
  S.history = JSON.parse(localStorage.getItem('mongosandbox_history') || '[]');
  renderHistoryPanel();
}

function saveToHistory(queryText, status, docsCount, executionTime) {
  const timeNum = parseFloat(executionTime) || 0;
  const entry = {
    id: Date.now(),
    query: queryText,
    status: status,
    docs: docsCount,
    time: timeNum,
    favorite: false,
    timestamp: new Date().toLocaleTimeString()
  };
  S.history.unshift(entry);
  if (S.history.length > 50) S.history.pop();
  localStorage.setItem('mongosandbox_history', JSON.stringify(S.history));
  renderHistoryPanel();
}

const PANEL_TITLES = {
  files: "Explorer",
  db: "DATABASE EXPLORER",
  history: "QUERY HISTORY",
  snippets: "SNIPPETS",
  search: "SEARCH"
};

function renderHistoryPanel() {
  const panel = document.getElementById('panel-history');
  if (!panel) return;
  const container = panel.querySelector('.panel-body') || panel;
  
  if (!S.history.length) {
    container.innerHTML = `
      <div style="padding:12px;color:var(--text3);font-size:12px">No recent queries in browser cache.</div>
    `;
    return;
  }
  
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px">
      <span style="font-size:10px;color:var(--text3);font-weight:bold;letter-spacing:.3px">RECENT RUNS (${S.history.length})</span>
      <button class="phbtn" title="Clear History" onclick="clearQueryHistory(event)" style="font-size:11px;padding:2px 6px">🗑️ Clear</button>
    </div>
    <div class="history-list">
      ${S.history.map(item => {
        const star = item.favorite ? '★' : '☆';
        const ok = item.status === 'ok' ? '✅' : '❌';
        const displayQ = item.query.replace(/\n/g, ' ').substring(0, 48);
        const tVal = typeof item.time === 'number' ? item.time : (parseFloat(item.time) || 0);
        return `
          <div class="history-item" onclick="loadHistoryEntry(${item.id})">
            <div class="history-item-top">
              <span class="history-status-icon">${ok}</span>
              <span class="history-query-short">${esc(displayQ)}</span>
              <span class="history-fav-star" onclick="toggleFavHistory(${item.id}, event)">${star}</span>
            </div>
            <div class="history-item-meta">
              <span>⏱ ${tVal.toFixed(1)}ms</span>
              <span>${item.docs} docs</span>
              <span>${item.timestamp}</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function clearQueryHistory(event) {
  if (event) event.stopPropagation();
  if (confirm('Clear all query history from your browser cache?')) {
    S.history = [];
    localStorage.removeItem('mongosandbox_history');
    renderHistoryPanel();
    logOutput('[info] Query history cleared from browser cache.');
  }
}

function loadHistoryEntry(id) {
  const entry = S.history.find(h => h.id === id);
  if (entry) {
    editor.setValue(entry.query);
    showView('ide');
  }
}

function toggleFavHistory(id, event) {
  event.stopPropagation();
  const entry = S.history.find(h => h.id === id);
  if (entry) {
    entry.favorite = !entry.favorite;
    localStorage.setItem('mongosandbox_history', JSON.stringify(S.history));
    renderHistoryPanel();
  }
}

function runPythonLocally(code, stdin, onFinish) {
  let stdout = '';
  let stderr = '';
  const stdinLines = stdin.split('\n');
  let stdinIndex = 0;
  
  function builtinRead(x) {
    if (Sk.builtinFiles === undefined || Sk.builtinFiles["files"][x] === undefined)
      throw "File not found: '" + x + "'";
    return Sk.builtinFiles["files"][x];
  }
  
  Sk.configure({
    output: function(text) {
      stdout += text;
    },
    read: builtinRead,
    inputfun: function(prompt) {
      if (stdinIndex < stdinLines.length) {
        return stdinLines[stdinIndex++];
      }
      return '';
    },
    timeoutMsg: function() {
      return "Timeout: Infinite loop or execution took too long.";
    }
  });
  
  Sk.execLimit = 5000; // 5s execution limit
  
  const start = performance.now();
  const myPromise = Sk.misceval.asyncToPromise(function() {
    return Sk.importMainWithBody("<stdin>", false, code, true);
  });
  
  myPromise.then(
    function(module) {
      const duration = (performance.now() - start).toFixed(2);
      onFinish({
        status: 'ok',
        code: 0,
        stdout: stdout,
        stderr: '',
        duration: duration
      });
    },
    function(err) {
      const duration = (performance.now() - start).toFixed(2);
      onFinish({
        status: 'ok',
        code: 1,
        stdout: stdout,
        stderr: err.toString(),
        duration: duration
      });
    }
  );
}

async function runPlaygroundCode(language, code, stdin) {
  const statEl = document.getElementById('console-status');
  if (statEl) statEl.innerHTML = `⟳ Compiling & Running...`;

  const timeEl = document.getElementById('console-time');
  const countEl = document.getElementById('console-count');
  if (timeEl) timeEl.textContent = '0ms';
  if (countEl) countEl.textContent = 'Playground';

  setConTab('output');
  const outView = document.getElementById('output-text');
  if (outView) {
    outView.innerHTML = `<span class="out-info">[info] Compiling and executing ${language} code...</span>`;
  }

  const runBtn = document.querySelector('.tbtn-run');
  if (runBtn) {
    runBtn.classList.add('running');
    runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Stop`;
  }

  const handleOutput = (d, duration) => {
    if (runBtn) {
      runBtn.classList.remove('running');
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;
    }

    if (d.status === 'ok') {
      const exitCode = d.code !== undefined ? d.code : 0;
      const stderr = (d.stderr || '').trim();
      const stdout = (d.stdout || '').trim();
      const isError = exitCode !== 0 || stderr.length > 0;

      if (statEl) {
        statEl.innerHTML = isError ? `<span style="color:var(--red)">✗ Execution Failed</span>` : `✓ Success`;
      }
      if (timeEl) timeEl.textContent = `${duration}ms`;

      if (outView) {
        let outputHTML = '';
        if (stdout) {
          outputHTML += `<pre style="margin: 0; font-family: inherit; color: #d4d4d4; white-space: pre-wrap; word-break: break-all;">${esc(stdout)}</pre>`;
        }
        if (stderr) {
          outputHTML += `<div class="out-err" style="margin-top: 8px; color: var(--red); white-space: pre-wrap; word-break: break-all;"><b>Errors:</b>\n${esc(stderr)}</div>`;
        }
        if (!stdout && !stderr) {
          outputHTML += `<div class="out-info">[Process completed successfully with exit code ${exitCode}]</div>`;
        }
        outView.innerHTML = outputHTML;
        outView.scrollTop = outView.scrollHeight;
      }

      saveToHistory(`${language.toUpperCase()} Code Run`, isError ? 'error' : 'ok', 0, duration);
    } else {
      if (statEl) statEl.innerHTML = `<span style="color:var(--red)">✗ Server Error</span>`;
      if (outView) {
        outView.innerHTML = `<div class="out-err"><b>[Error] Failed to execute code:</b> ${esc(d.error || 'Server error')}</div>`;
      }
      saveToHistory(`${language.toUpperCase()} Code Run`, 'error', 0, 0);
    }
  };

  // Run client-side Python if Skulpt is available
  if (language === 'python' && typeof Sk !== 'undefined') {
    runPythonLocally(code, stdin, function(res) {
      handleOutput(res, res.duration);
    });
    return;
  }

  try {
    const start = performance.now();
    const d = await fetchAPI('/api/sandbox/run', {
      method: 'POST',
      body: JSON.stringify({
        language: language,
        code: code,
        stdin: stdin
      })
    });
    const duration = (performance.now() - start).toFixed(2);
    handleOutput(d, duration);
  } catch (err) {
    if (runBtn) {
      runBtn.classList.remove('running');
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;
    }
    if (statEl) statEl.innerHTML = `<span style="color:var(--red)">✗ Request Failed</span>`;
    if (outView) {
      outView.innerHTML = `<div class="out-err"><b>[Error] Request failed:</b> ${esc(err.message || err)}</div>`;
    }
    saveToHistory(`${language.toUpperCase()} Code Run`, 'error', 0, 0);
  }
}

function changeWorkspaceLanguage(newLang) {
  const isMongo = newLang === 'mongodb';
  const inspectorEl = document.getElementById('inspector');
  const btnToggleInspector = document.getElementById('btn-toggle-inspector');
  const btnSchemaEr = document.getElementById('btn-schema-er');
  
  if (isMongo) {
    if (inspectorEl) inspectorEl.style.display = S.inspectorOpen ? 'flex' : 'none';
    if (btnToggleInspector) btnToggleInspector.style.display = 'flex';
    if (btnSchemaEr) btnSchemaEr.style.display = 'flex';
  } else {
    if (inspectorEl) inspectorEl.style.display = 'none';
    if (btnToggleInspector) btnToggleInspector.style.display = 'none';
    if (btnSchemaEr) btnSchemaEr.style.display = 'none';
  }

  let cmMode = 'javascript';
  let placeholder = '// Write your MongoDB query here\ndb.collection.find({})';
  let langIndicator = 'Mongo Shell';
  
  if (newLang === 'python') {
    cmMode = 'python';
    placeholder = '# Write your Python 3 code here\nprint("Hello World")\n';
    langIndicator = 'Python 3';
  } else if (newLang === 'cpp') {
    cmMode = 'text/x-c++src';
    placeholder = '#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello World" << endl;\n    return 0;\n}\n';
    langIndicator = 'C++';
  } else if (newLang === 'c') {
    cmMode = 'text/x-c++src';
    placeholder = '#include <stdio.h>\n\nint main() {\n    printf("Hello World\\n");\n    return 0;\n}\n';
    langIndicator = 'C';
  } else if (newLang === 'java') {
    cmMode = 'text/x-java';
    placeholder = 'public class Solution {\n    public static void main(String[] args) {\n        System.out.println("Hello World");\n    }\n}\n';
    langIndicator = 'Java';
  }
  
  const langIndicatorEl = document.getElementById('sb-lang-indicator');
  if (langIndicatorEl) {
    langIndicatorEl.textContent = langIndicator;
  }

  // Toggle console views
  const conTabs = document.getElementById('console-tabs');
  const conSubTabs = document.getElementById('console-sub-tabs');
  const ctabStdin = document.getElementById('ctab-stdin');

  if (isMongo) {
    if (conTabs) conTabs.style.display = 'flex';
    if (conSubTabs) conSubTabs.style.display = 'flex';
    if (ctabStdin) ctabStdin.style.display = 'none';
    if (S.conTab === 'stdin') S.conTab = 'output';
    setConTab(S.conTab);
  } else {
    if (conTabs) conTabs.style.display = 'flex';
    if (conSubTabs) conSubTabs.style.display = 'none';
    if (ctabStdin) ctabStdin.style.display = 'block';
    if (!['output', 'logs', 'stdin'].includes(S.conTab)) {
      S.conTab = 'output';
    }
    setConTab(S.conTab);
  }

  if (editor) {
    editor.setOption('mode', cmMode);
    editor.setValue(placeholder);
    setTimeout(() => editor.refresh(), 50);
  }
}
