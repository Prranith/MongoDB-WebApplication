// ═══════════════════════════════════════════════════════════════════
// EXECUTE QUERY RUNNER
// ═══════════════════════════════════════════════════════════════════
// Each SQL file gets an isolated table snapshot. The API executes against an
// in-memory SQLite copy and returns the new snapshot after mutations; nothing
// is written to server databases or shared JSON files.
const SQL_SANDBOXES = new Map();
const SQL_NOTEBOOK_OUTPUTS = new Map();
let SQL_NOTEBOOK_EDITORS = [];

function sqlSandboxKey() {
  return S.activeFile || '__workspace_editor__';
}

function isSqlMutation(query) {
  const statement = String(query || '').replace(/^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/g, '').trim();
  return /^(?:(?:with\b[\s\S]*?\b(?:insert|update|delete|replace)\b)|(?:insert|update|delete|replace|create|alter|drop)\b)/i.test(statement);
}

function isSqlNotebookFile() {
  return String(S.activeFile || '').toLowerCase().endsWith('.sql');
}

function setSqlNotebookMode(active) {
  const panel = document.getElementById('ide-panel');
  if (panel) panel.classList.toggle('sql-notebook-mode', !!active);
}

function splitSqlNotebookCells(source) {
  const lines = String(source || '').split(/\r?\n/);
  const marker = /^\s*--\s*(?:#?%%|cell\b.*)$/i;
  if (!lines.some(line => marker.test(line))) {
    const cells = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < String(source || '').length; index++) {
      const char = String(source || '')[index];
      const next = String(source || '')[index + 1] || '';
      current += char;
      if (quote) {
        if (char === quote && next === quote) { current += next; index++; }
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === ';') { if (current.trim()) cells.push(current.trim()); current = ''; }
    }
    if (current.trim()) cells.push(current.trim());
    return cells.length ? cells : [''];
  }
  const cells = [];
  let current = [];
  let sawMarker = false;
  lines.forEach(line => {
    if (marker.test(line)) {
      sawMarker = true;
      // After the first marker, an empty segment is a real blank cell. Keep
      // it so newly inserted cells do not disappear until the user types.
      if (current.join('\n').trim() || cells.length || sawMarker && current.length > 0) cells.push(current.join('\n').trim());
      current = [];
    } else current.push(line);
  });
  if (current.join('\n').trim() || !cells.length || sawMarker) cells.push(current.join('\n').trim());
  return cells;
}

function sqlNotebookSourceFromInputs() {
  const inputs = [...document.querySelectorAll('.sql-notebook-cell')].map((cell, index) => {
    const instance = SQL_NOTEBOOK_EDITORS[index];
    return instance ? instance.getValue() : (cell.querySelector('.sql-cell-input')?.value || '');
  });
  return inputs.map((value, index) => `${index ? '-- %%\n' : ''}${value}`.trim()).join('\n\n');
}

function getSqlNotebookCellValues() {
  return [...document.querySelectorAll('.sql-notebook-cell')].map((cell, index) => {
    const instance = SQL_NOTEBOOK_EDITORS[index];
    return instance ? instance.getValue() : (cell.querySelector('.sql-cell-input')?.value || '');
  });
}

function syncSqlNotebookToFile() {
  if (!editor || !S.activeFile) return;
  const source = sqlNotebookSourceFromInputs();
  if (editor.getValue() !== source) editor.setValue(source);
  const file = S.files.find(item => item.path === S.activeFile);
  if (file) file.content = source;
  if (typeof persistBrowserWorkspace === 'function') persistBrowserWorkspace();
  if (typeof scheduleWorkspaceFileWrite === 'function' && file) scheduleWorkspaceFileWrite(file);
}

function sqlNotebookIcon(name) {
  const paths = {
    run: '<path d="M8 5v14l11-7z"/>',
    clear: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function formatSqlCellResult(result) {
  if (!result || !Array.isArray(result.columns) || !result.columns.length) {
    return `${result?.operation || 'Statement'} completed · ${result?.affectedRows || 0} row(s) affected`;
  }
  const columns = result.columns;
  const rows = result.rows || [];
  const widths = columns.map(column => Math.max(String(column).length, ...rows.map(row => String(row[column] ?? '').length), 3));
  const line = '+' + widths.map(width => '-'.repeat(width + 2)).join('+') + '+';
  const format = values => '| ' + values.map((value, index) => String(value ?? '').padEnd(widths[index])).join(' | ') + ' |';
  return [line, format(columns), line, ...rows.map(row => format(columns.map(column => row[column]))), line, `${result.rowCount} row(s) returned`].join('\n');
}

function renderSqlResultTable(result, extraClass = '') {
  const columns = Array.isArray(result && result.columns) ? result.columns : [];
  const rows = Array.isArray(result && result.rows) ? result.rows : [];
  if (!columns.length) {
    const affected = result && result.affectedRows != null ? result.affectedRows : 0;
    return `<div class="sql-result-empty">${esc(result && result.operation ? `${String(result.operation).toUpperCase()} completed · ${affected} row(s) affected` : 'Query returned no columns')}</div>`;
  }
  const header = columns.map(column => `<th scope="col">${esc(column)}</th>`).join('');
  const body = rows.map(row => `<tr>${columns.map(column => {
    const value = row && row[column] != null ? row[column] : 'NULL';
    return `<td>${esc(value)}</td>`;
  }).join('')}</tr>`).join('');
  const count = result && result.rowCount != null ? result.rowCount : rows.length;
  return `<div class="sql-result-table-wrap ${extraClass}"><table class="sql-result-table"><thead><tr>${header}</tr></thead><tbody>${body || `<tr><td class="sql-result-no-rows" colspan="${columns.length}">No rows returned</td></tr>`}</tbody></table><div class="sql-result-meta">${count} row${count === 1 ? '' : 's'} returned</div></div>`;
}

function renderSqlNotebook(source) {
  const notebook = document.getElementById('sql-notebook');
  if (!notebook) return;
  if (!notebook.dataset.actionsBound) {
    notebook.addEventListener('click', event => {
      const trigger = event.target.closest('[data-sql-action="add-cell"]');
      if (!trigger || !notebook.contains(trigger)) return;
      event.preventDefault();
      event.stopPropagation();
      insertSqlNotebookCell(Number(trigger.dataset.insertIndex || SQL_NOTEBOOK_EDITORS.length));
    });
    notebook.dataset.actionsBound = 'true';
  }
  const cells = splitSqlNotebookCells(source);
  const runtimeKey = S.activeFile || '__workspace_editor__';
  const saved = SQL_NOTEBOOK_OUTPUTS.get(runtimeKey) || {};
  SQL_NOTEBOOK_EDITORS = [];
  notebook.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'sql-notebook-header';
  header.innerHTML = `<strong>SQL Notebook</strong><span>${cells.length} cell${cells.length === 1 ? '' : 's'}</span>`;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'sql-notebook-action';
  reset.textContent = 'Restart runtime';
  reset.onclick = () => {
    SQL_SANDBOXES.delete(runtimeKey);
    SQL_NOTEBOOK_OUTPUTS.delete(runtimeKey);
    renderSqlNotebook(editor ? editor.getValue() : source);
  };
  const runAll = document.createElement('button');
  runAll.type = 'button';
  runAll.className = 'sql-notebook-action';
  runAll.textContent = 'Run all';
  runAll.onclick = async () => { for (let index = 0; index < document.querySelectorAll('.sql-notebook-cell').length; index++) await runSqlNotebookCell(index); };
  const addCell = document.createElement('button');
  addCell.type = 'button';
  addCell.dataset.sqlAction = 'add-cell';
  addCell.dataset.insertIndex = String(cells.length);
  addCell.className = 'sql-notebook-action';
  addCell.textContent = '+ Cell';
  addCell.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    insertSqlNotebookCell(getSqlNotebookCellValues().length);
  };
  header.append(runAll, addCell, reset);
  notebook.appendChild(header);
  cells.forEach((cellSource, index) => {
    const cell = document.createElement('section');
    cell.className = 'sql-notebook-cell';
    cell.dataset.cellIndex = String(index);
    const cellHeader = document.createElement('div');
    cellHeader.className = 'sql-notebook-cell-header';
    cellHeader.innerHTML = `<strong>Cell ${index + 1}</strong><span>SQL</span>`;
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'sql-notebook-icon';
    run.title = 'Run cell';
    run.setAttribute('aria-label', 'Run cell');
    run.innerHTML = sqlNotebookIcon('run');
    run.onclick = () => runSqlNotebookCell(index);
    cellHeader.appendChild(run);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sql-notebook-icon';
    clear.title = 'Clear cell output';
    clear.setAttribute('aria-label', 'Clear cell output');
    clear.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    clear.onclick = () => {
      output.textContent = '';
      output.classList.remove('has-result', 'error');
      const outputs = SQL_NOTEBOOK_OUTPUTS.get(runtimeKey) || {};
      delete outputs[index];
      SQL_NOTEBOOK_OUTPUTS.set(runtimeKey, outputs);
    };
    cellHeader.appendChild(clear);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sql-notebook-icon sql-notebook-delete';
    remove.title = 'Delete cell';
    remove.setAttribute('aria-label', 'Delete cell');
    remove.innerHTML = sqlNotebookIcon('delete');
    remove.onclick = () => deleteSqlNotebookCell(index);
    cellHeader.appendChild(remove);
    const input = document.createElement('textarea');
    input.className = 'sql-cell-input';
    input.value = cellSource;
    input.spellcheck = false;
    const output = document.createElement('pre');
    output.className = 'sql-cell-output';
    if (saved[index]) {
      if (saved[index].html) output.innerHTML = saved[index].html;
      else output.textContent = saved[index].text || '';
      output.classList.add('has-result');
      if (saved[index].error) output.classList.add('error');
    }
    cell.append(cellHeader, input, output);
    notebook.appendChild(cell);
    const editorInstance = CodeMirror.fromTextArea(input, {
      mode: 'text/x-sql',
      theme: 'default',
      lineNumbers: true,
      lineWrapping: true,
      matchBrackets: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Ctrl-Enter': () => runSqlNotebookCell(index),
        'Cmd-Enter': () => runSqlNotebookCell(index),
      },
    });
    const resize = () => editorInstance.setSize('100%', `${Math.max(30, Math.min(420, editorInstance.lineCount() * 20 + 10))}px`);
    resize();
    editorInstance.on('change', () => { resize(); syncSqlNotebookToFile(); });
    SQL_NOTEBOOK_EDITORS.push(editorInstance);
    const insert = document.createElement('div');
    insert.className = 'sql-notebook-insert';
    const insertButton = document.createElement('button');
    insertButton.type = 'button';
    insertButton.dataset.sqlAction = 'add-cell';
    insertButton.dataset.insertIndex = String(index + 1);
    insertButton.textContent = '+ Add code cell';
    insert.appendChild(insertButton);
    notebook.appendChild(insert);
  });
}

function insertSqlNotebookCell(index) {
  syncSqlNotebookToFile();
  const values = getSqlNotebookCellValues();
  values.splice(Math.max(0, Math.min(index, values.length)), 0, '');
  const source = values.map((value, cellIndex) => `${cellIndex ? '-- %%\n' : ''}${value}`).join('\n\n');
  if (editor) editor.setValue(source);
  initializeSqlNotebook(source);
  setTimeout(() => SQL_NOTEBOOK_EDITORS[index]?.focus(), 0);
}

function deleteSqlNotebookCell(index) {
  if (document.querySelectorAll('.sql-notebook-cell').length <= 1) return;
  syncSqlNotebookToFile();
  const values = getSqlNotebookCellValues();
  values.splice(index, 1);
  const runtimeKey = S.activeFile || '__workspace_editor__';
  SQL_NOTEBOOK_OUTPUTS.delete(runtimeKey);
  const source = values.map((value, cellIndex) => `${cellIndex ? '-- %%\n' : ''}${value}`).join('\n\n');
  if (editor) editor.setValue(source);
  initializeSqlNotebook(source);
}

function initializeSqlNotebook(source) {
  setSqlNotebookMode(true);
  renderSqlNotebook(source);
}

async function runSqlNotebookCell(index) {
  syncSqlNotebookToFile();
  const cell = document.querySelector(`.sql-notebook-cell[data-cell-index="${index}"]`);
  if (!cell) return;
  const input = cell.querySelector('.sql-cell-input');
  const output = cell.querySelector('.sql-cell-output');
  const query = (SQL_NOTEBOOK_EDITORS[index]?.getValue() || input.value).trim();
  if (!query) return;
  output.classList.add('has-result');
  output.classList.remove('error');
  output.textContent = 'Running…';
  const runtimeKey = S.activeFile || '__workspace_editor__';
  try {
    const requestBody = { query, limit: S.settings ? S.settings.maxResults : 500 };
    if (SQL_SANDBOXES.has(runtimeKey)) requestBody.tables = SQL_SANDBOXES.get(runtimeKey);
    const result = await fetchAPI('/api/sql/run', { method: 'POST', body: JSON.stringify(requestBody) });
    if (result.status !== 'ok') throw new Error(result.error || 'SQL execution failed');
    if (result.tables) SQL_SANDBOXES.set(runtimeKey, result.tables);
    const html = renderSqlResultTable(result, 'sql-notebook-result');
    output.innerHTML = html;
    SQL_NOTEBOOK_OUTPUTS.set(runtimeKey, { ...(SQL_NOTEBOOK_OUTPUTS.get(runtimeKey) || {}), [index]: { html } });
  } catch (error) {
    output.classList.add('error');
    output.textContent = `[error] ${error.message}`;
    SQL_NOTEBOOK_OUTPUTS.set(runtimeKey, { ...(SQL_NOTEBOOK_OUTPUTS.get(runtimeKey) || {}), [index]: { text: output.textContent, error: true } });
  }
}

async function runQuery() {
  const consoleEl = document.getElementById('console');
  if (consoleEl && (consoleEl.style.display === 'none' || consoleEl.offsetHeight <= 10)) {
    toggleConsole();
  }
  const lang = getWorkspaceLanguage();
  const source = editor.getValue();
  const looksLikeSql = /^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*\s*(?:select|with)\b/i.test(source);
  // Treat an obvious SQL statement as SQL even if an older saved workspace
  // language value left the selector on MongoDB mode.
  if (lang === 'sql' || looksLikeSql) {
    if (lang === 'sql' && isSqlNotebookFile()) {
      const activeCell = document.querySelector('.sql-notebook-cell:focus-within');
      const index = activeCell ? Number(activeCell.dataset.cellIndex) : 0;
      await runSqlNotebookCell(index);
      return;
    }
    const q = source.trim();
    if (!q) return;
    const statEl = document.getElementById('console-status');
    if (statEl) statEl.textContent = '⟳ Running SQL...';
    try {
      const sandboxKey = sqlSandboxKey();
      const requestBody = { query: q, limit: S.settings ? S.settings.maxResults : 500 };
      if (SQL_SANDBOXES.has(sandboxKey)) requestBody.tables = SQL_SANDBOXES.get(sandboxKey);
      const d = await fetchAPI('/api/sql/run', { method: 'POST', body: JSON.stringify(requestBody) });
      if (d.status !== 'ok') throw new Error(d.error || 'SQL execution failed');
      if (d.tables) SQL_SANDBOXES.set(sandboxKey, d.tables);
      S.lastData = d.rows; S.lastRaw = JSON.stringify(d, null, 2);
      const resultCount = d.operation && d.operation !== 'select' ? (d.affectedRows || 0) : d.rowCount;
      if (statEl) statEl.textContent = d.operation && d.operation !== 'select'
        ? `✓ ${d.operation.toUpperCase()} completed · ${resultCount} row(s) affected`
        : `✓ ${d.rowCount} row(s) returned`;
      if (document.getElementById('console-time')) document.getElementById('console-time').textContent = `${d.duration || 0}ms`;
      if (document.getElementById('console-count')) document.getElementById('console-count').textContent = `${resultCount} ${d.operation && d.operation !== 'select' ? 'affected' : 'rows'}`;
      renderTreeView(d.rows); renderRawJsonView(d); renderSqlTable(d);
    } catch (e) { if (statEl) statEl.textContent = `✕ ${e.message}`; logOutput(`<span class="out-error">[error] ${e.message}</span>`); }
    return;
  }
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

function renderSqlTable(result) {
  const container = document.getElementById('output-text');
  if (!container || !result || !Array.isArray(result.columns)) return;
  container.innerHTML = renderSqlResultTable(result);
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
  const lang = getWorkspaceLanguage();
  const isMongo = lang === 'mongodb';

  ['output', 'logs', 'stdin'].forEach(function(t) {
    const el = document.getElementById(`ctab-${t}`);
    if (el) el.classList.toggle('active', t === tab);
  });
  
  const treeView = document.getElementById('tree-view');
  const rawView = document.getElementById('raw-view');
  const outputView = document.getElementById('output-view');
  const logsView = document.getElementById('logs-view');
  const terminalView = document.getElementById('terminal-view');
  const viewBtns = document.getElementById('view-btns');
  
  if (isMongo) {
    const showOutput = tab === 'output';
    if (treeView) treeView.style.display = (showOutput && S.resultView === 'tree') ? 'flex' : 'none';
    if (rawView) rawView.style.display = (showOutput && S.resultView === 'raw') ? 'block' : 'none';
    if (outputView) outputView.style.display = (showOutput && S.resultView === 'out') ? 'block' : 'none';
    if (logsView) logsView.style.display = tab === 'logs' ? 'flex' : 'none';
    if (terminalView) terminalView.style.display = 'none';
    if (viewBtns) viewBtns.style.display = showOutput ? 'flex' : 'none';
  } else {
    if (treeView) treeView.style.display = 'none';
    if (rawView) rawView.style.display = 'none';
    if (viewBtns) viewBtns.style.display = 'none';
    if (logsView) logsView.style.display = tab === 'logs' ? 'flex' : 'none';
    
    if (tab === 'stdin') {
      if (outputView) outputView.style.display = 'none';
      if (terminalView) terminalView.style.display = 'flex';
    } else if (tab === 'output') {
      if (outputView) outputView.style.display = 'block';
      if (terminalView) terminalView.style.display = 'none';
    } else {
      if (outputView) outputView.style.display = 'none';
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
  const executionLog = document.getElementById('execution-log-output');
  if (executionLog) executionLog.innerHTML = `<span class="out-info">// Execution diagnostics cleared</span>`;
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

let executionProgressTimer = null;
let executionCliLines = [];

function resetExecutionCli() {
  executionCliLines = [];
}

function renderExecutionCli() {
  const logView = document.getElementById('execution-log-output');
  if (!logView) return;
  logView.innerHTML = executionCliMarkup() || '<span class="out-info">// Execution diagnostics will appear here.</span>';
  logView.scrollTop = logView.scrollHeight;
}

function executionCliMarkup() {
  return executionCliLines.map(line => `<div class="execution-cli-line">${esc(line)}</div>`).join('');
}

function appendExecutionCli(detail) {
  const text = String(detail || '').trim();
  if (!text || executionCliLines[executionCliLines.length - 1] === text) return;
  executionCliLines.push(text);
  renderExecutionCli();
}

function stopExecutionProgress() {
  if (executionProgressTimer) {
    clearInterval(executionProgressTimer);
    executionProgressTimer = null;
  }
}

function setExecutionOrigin(origin, language, running, detail) {
  stopExecutionProgress();
  const isLocal = origin === 'local';
  const label = isLocal ? 'Local execution' : 'Remote execution';
  const message = detail || (isLocal
    ? 'CodeLeaf is executing this program on your device.'
    : 'CodeLeaf is executing this program on a dedicated CodeLeaf execution worker.');
  const statEl = document.getElementById('console-status');
  const stateClass = isLocal ? 'execution-origin-local' : 'execution-origin-remote';

  const phases = isLocal ? `Preparing ${language} runtime…` : 'Connecting to a dedicated worker…';
  const current = detail || phases;
  if (statEl) {
    statEl.innerHTML = `<span class="execution-origin ${stateClass}"><span class="execution-origin-dot"></span>${label}</span>${running ? ` <span class="execution-phase">· ${esc(current)}</span>` : ''}`;
  }
  appendExecutionCli(`[codeleaf] ${current}`);
}

function updateExecutionProgress(progress) {
  const detail = progress && progress.detail ? progress.detail : '';
  if (!detail) return;
  appendExecutionCli(`[codeleaf] ${detail}`);
  const statEl = document.getElementById('console-status');
  const phase = statEl && statEl.querySelector('.execution-phase');
  if (phase) phase.textContent = `· ${detail}`;
}

function executionOriginBanner(origin, fallbackNotice) {
  const isLocal = origin === 'local';
  const label = isLocal ? 'Local execution' : 'Remote execution';
  const notice = fallbackNotice ? `<div class="execution-origin-cli execution-origin-note">[fallback] ${esc(fallbackNotice)}</div>` : '';
  return notice;
}

function executionOriginInline(origin) {
  const isLocal = origin === 'local';
  const stateClass = isLocal ? 'execution-origin-local' : 'execution-origin-remote';
  const label = isLocal ? 'device' : 'remote worker';
  return `<span class="execution-origin-inline ${stateClass}"><span class="execution-origin-dot"></span>${label}</span>`;
}

async function runPlaygroundCode(language, code, stdin) {
  const allowed = ['c', 'cpp', 'java', 'python', 'mongodb'];
  if (!allowed.includes(language)) {
    const message = `${language || 'This'} format is not allowed to run by the app.`;
    logOutput(`<span class="out-error">[error] ${message}</span>`);
    const status = document.getElementById('console-status');
    if (status) status.textContent = `✕ ${message}`;
    return;
  }
  const statEl = document.getElementById('console-status');

  const timeEl = document.getElementById('console-time');
  const countEl = document.getElementById('console-count');
  if (timeEl) timeEl.textContent = '0ms';
  if (countEl) countEl.textContent = 'Playground';

  setConTab('output');
  resetExecutionCli();
  const outView = document.getElementById('output-text');
  if (outView) outView.innerHTML = '';
  const logView = document.getElementById('execution-log-output');
  if (logView) logView.innerHTML = '';
  appendExecutionCli('[codeleaf] Selecting the safest available execution runtime…');

  const runBtn = document.querySelector('.tbtn-run');
  if (runBtn) {
    runBtn.classList.add('running');
    runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Stop`;
  }

  const handleOutput = (d, duration, fallbackNotice) => {
    stopExecutionProgress();
    if (runBtn) {
      runBtn.classList.remove('running');
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;
    }

    const origin = d.executionOrigin || 'remote';
    if (d.status === 'ok') {
      const exitCode = d.code !== undefined ? d.code : 0;
      const stderr = (d.stderr || '').trim();
      const stdout = (d.stdout || '').trim();
      const isError = exitCode !== 0 || stderr.length > 0;

      if (statEl) {
        statEl.innerHTML = isError
          ? `<span style="color:var(--red)">✗ Execution Failed</span> ${executionOriginInline(origin)}`
          : `<span style="color:var(--green3)">✓ Success</span> ${executionOriginInline(origin)}`;
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
      if (fallbackNotice) appendExecutionCli(`[codeleaf] [fallback] ${fallbackNotice}`);

      saveToHistory(`${language.toUpperCase()} Code Run`, isError ? 'error' : 'ok', 0, duration);
    } else {
      if (statEl) statEl.innerHTML = `<span style="color:var(--red)">✗ ${origin === 'local' ? 'Local runtime error' : 'Remote execution error'}</span> ${executionOriginInline(origin)}`;
      if (outView) {
        outView.innerHTML = `<div class="out-err"><b>[Error] Failed to execute code:</b> ${esc(d.error || 'Execution error')}</div>`;
      }
      saveToHistory(`${language.toUpperCase()} Code Run`, 'error', 0, 0);
    }
  };

  // Normal workspace Python, C, C++ and Java runs use browser WebAssembly workers.
  // Exams intentionally use their server-side authoritative path in exam.js.
  if (typeof ClientExecution !== 'undefined' && ClientExecution.supports(language)) {
    setExecutionOrigin('local', language, true);
    const clientTimeout = language === 'java' || language === 'c' || language === 'cpp' ? 60000 : 8000;
    const clientResult = await ClientExecution.run(language, code, stdin, {
      timeoutMs: clientTimeout,
      fileName: S.activeFile || 'Main.java',
      onProgress: updateExecutionProgress
    });
    if (clientResult) {
      if (clientResult.runtime !== 'codeleaf-browser') {
        clientResult.executionOrigin = 'local';
        handleOutput(clientResult, clientResult.duration);
        return;
      }
      const localFailure = clientResult.stderr || 'The browser runtime could not execute this program.';
      setExecutionOrigin('remote', language, true, 'On-device runtime unavailable; switching to a dedicated worker.');
      updateExecutionProgress({ detail: 'Submitting program to the remote worker…' });
      try {
        const start = performance.now();
        const d = await fetchAPI('/api/sandbox/run', {
          method: 'POST',
          body: JSON.stringify({ language, code, stdin, filename: S.activeFile || '' })
        });
        updateExecutionProgress({ detail: 'Remote worker completed execution.' });
        d.executionOrigin = 'remote';
        handleOutput(d, (performance.now() - start).toFixed(2), `On-device attempt: ${localFailure}`);
        return;
      } catch (err) {
        handleOutput({ status: 'ok', code: 1, stderr: `On-device attempt failed: ${localFailure}\nRemote worker request failed: ${err.message || err}`, executionOrigin: 'remote' }, 0, localFailure);
        return;
      }
    }
  }

  try {
    setExecutionOrigin('remote', language, true);
    const start = performance.now();
    const d = await fetchAPI('/api/sandbox/run', {
      method: 'POST',
      body: JSON.stringify({
        language: language,
        code: code,
        stdin: stdin,
        filename: S.activeFile || ''
      })
    });
    const duration = (performance.now() - start).toFixed(2);
    d.executionOrigin = 'remote';
    handleOutput(d, duration);
  } catch (err) {
    if (runBtn) {
      runBtn.classList.remove('running');
      runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg> Run`;
    }
    if (statEl) statEl.innerHTML = `<span style="color:var(--red)">✗ Remote request failed</span>`;
    if (outView) {
      outView.innerHTML = `${executionOriginBanner('remote')}<div class="out-err"><b>[Error] Request failed:</b> ${esc(err.message || err)}</div>`;
    }
    saveToHistory(`${language.toUpperCase()} Code Run`, 'error', 0, 0);
  }
}

function updateWorkspaceConsoleLayout(newLang) {
  const activePath = String(S.activeFile || '');
  const isMongoFile = /\.(mongo|mongodb|js)$/i.test(activePath);
  const isMongo = newLang === 'mongodb' && isMongoFile;
  const isInspectorFile = /\.(sql|mongo)$/i.test(activePath);
  const inspectorEl = document.getElementById('inspector');
  const btnToggleInspector = document.getElementById('btn-toggle-inspector');
  const menuToggleInspector = document.getElementById('menu-toggle-inspector');
  
  if (isInspectorFile) {
    if (inspectorEl) inspectorEl.style.display = S.inspectorOpen ? 'flex' : 'none';
    if (btnToggleInspector) btnToggleInspector.style.display = 'flex';
    if (menuToggleInspector) menuToggleInspector.style.display = 'flex';
  } else {
    if (inspectorEl) inspectorEl.style.display = 'none';
    if (btnToggleInspector) btnToggleInspector.style.display = 'none';
    if (menuToggleInspector) menuToggleInspector.style.display = 'none';
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
}

// Make it globally accessible
window.updateWorkspaceConsoleLayout = updateWorkspaceConsoleLayout;
