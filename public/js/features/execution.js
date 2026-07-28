// ═══════════════════════════════════════════════════════════════════
// EXECUTE QUERY RUNNER
// ═══════════════════════════════════════════════════════════════════
async function runQuery() {
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
          ${esc(icon)}
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
  ['output', 'logs'].forEach(t => {
    document.getElementById(`ctab-${t}`).classList.toggle('active', t === tab);
  });
  
  const showOutput = tab === 'output';
  document.getElementById('tree-view').style.display = (showOutput && S.resultView === 'tree') ? 'flex' : 'none';
  document.getElementById('raw-view').style.display = (showOutput && S.resultView === 'raw') ? 'block' : 'none';
  document.getElementById('output-view').style.display = (!showOutput || S.resultView === 'out') ? 'block' : 'none';
  document.getElementById('view-btns').style.display = showOutput ? 'flex' : 'none';
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
  const entry = {
    id: Date.now(),
    query: queryText,
    status: status,
    docs: docsCount,
    time: executionTime,
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
        return `
          <div class="history-item" onclick="loadHistoryEntry(${item.id})">
            <div class="history-item-top">
              <span class="history-status-icon">${ok}</span>
              <span class="history-query-short">${esc(displayQ)}</span>
              <span class="history-fav-star" onclick="toggleFavHistory(${item.id}, event)">${star}</span>
            </div>
            <div class="history-item-meta">
              <span>⏱ ${item.time.toFixed(1)}ms</span>
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
