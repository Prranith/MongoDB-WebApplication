// Workspace search: fast local search over the files already loaded in the browser.
let workspaceSearchReady = false;

function initWorkspaceSearch() {
  const input = document.getElementById('workspace-search-input');
  if (!input) return;
  if (!workspaceSearchReady) {
    workspaceSearchReady = true;
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') clearWorkspaceSearch();
    });
  }
  input.focus();
  searchWorkspace();
}

function clearWorkspaceSearch() {
  const input = document.getElementById('workspace-search-input');
  if (input) input.value = '';
  searchWorkspace();
  if (input) input.focus();
}

function searchWorkspace() {
  const input = document.getElementById('workspace-search-input');
  const resultsEl = document.getElementById('workspace-search-results');
  const statusEl = document.getElementById('workspace-search-status');
  if (!input || !resultsEl || !statusEl) return;

  const query = input.value.trim();
  if (!query) {
    statusEl.textContent = 'Search across the current workspace';
    resultsEl.innerHTML = '<div class="workspace-search-empty">Type a file name or text to search.</div>';
    return;
  }

  const scope = document.getElementById('workspace-search-scope')?.value || 'all';
  const matchCase = Boolean(document.getElementById('workspace-search-case')?.checked);
  const useRegex = Boolean(document.getElementById('workspace-search-regex')?.checked);
  let matcher;
  try {
    matcher = useRegex ? new RegExp(query, matchCase ? 'g' : 'gi') : null;
  } catch (error) {
    statusEl.textContent = 'Invalid regular expression';
    resultsEl.innerHTML = `<div class="workspace-search-empty search-error">${esc(error.message)}</div>`;
    return;
  }

  const needle = matchCase ? query : query.toLowerCase();
  const files = Array.isArray(S.files) ? S.files : [];
  const results = [];
  files.forEach(file => {
    const path = String(file.path || '');
    const name = String(file.name || path.split('/').pop() || '');
    const nameMatch = scope !== 'content' && (matcher ? testRegex(matcher, name) : (matchCase ? name : name.toLowerCase()).includes(needle));
    if (file.type === 'folder') {
      if (nameMatch) results.push({ file, kind: 'folder', line: 0, snippet: path });
      return;
    }
    if (nameMatch) results.push({ file, kind: 'file', line: 0, snippet: path });
    if (scope === 'names') return;

    const content = String(file.content || '');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (results.length >= 300) return;
      const found = matcher ? testRegex(matcher, line) : (matchCase ? line : line.toLowerCase()).includes(needle);
      if (found) results.push({ file, kind: 'content', line: index + 1, snippet: line.trim() || ' ' });
    });
  });

  const fileCount = new Set(results.map(result => result.file.path)).size;
  statusEl.textContent = results.length
    ? `${results.length}${results.length === 300 ? '+' : ''} result${results.length === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
    : 'No matches found';
  resultsEl.innerHTML = results.length ? results.map((result, index) => {
    const label = result.kind === 'folder' ? 'Folder' : result.kind === 'content' ? `Line ${result.line}` : 'File name';
    return `<button type="button" class="workspace-search-result" data-result-index="${index}" role="listitem">
      <span class="workspace-search-result-icon">${result.kind === 'folder' ? '▰' : '▤'}</span>
      <span class="workspace-search-result-main"><span class="workspace-search-result-path">${esc(result.file.path)}</span><span class="workspace-search-result-meta">${label}</span>${result.kind === 'content' ? `<span class="workspace-search-result-snippet">${esc(result.snippet)}</span>` : ''}</span>
    </button>`;
  }).join('') : '<div class="workspace-search-empty">No files or content match this search.</div>';

  resultsEl.querySelectorAll('[data-result-index]').forEach(element => {
    element.addEventListener('click', () => {
      const result = results[Number(element.dataset.resultIndex)];
      if (!result || result.kind === 'folder') return;
      openFileInTab(result.file.path);
      if (result.line > 0 && typeof editor !== 'undefined' && editor) {
        editor.setCursor({ line: result.line - 1, ch: 0 });
        editor.scrollIntoView({ line: result.line - 1, ch: 0 }, 120);
        editor.focus();
      }
    });
  });
}

function testRegex(regex, value) {
  regex.lastIndex = 0;
  return regex.test(value);
}

window.initWorkspaceSearch = initWorkspaceSearch;
window.searchWorkspace = searchWorkspace;
window.clearWorkspaceSearch = clearWorkspaceSearch;
