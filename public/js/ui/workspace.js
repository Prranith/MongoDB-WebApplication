// ═══════════════════════════════════════════════════════════════════
// FILES WORKSPACE MANAGEMENT (LocalStorage Sync)
// ═══════════════════════════════════════════════════════════════════
async function loadFiles() {
  try {
    const d = await fetchAPI('/api/files');
    const serverFiles = d.files || [];
    
    // Read local override from localStorage
    const localOverride = JSON.parse(localStorage.getItem('mongosandbox_files') || '[]');
    
    const legacyPaths = ['01_find_paid.mongo', '02_aggregate_pipeline.mongo', 'kishor.mongo'];
    // Merge server files with local modifications, ignoring legacy files
    const cleanLocalOverride = localOverride.filter(lf => !legacyPaths.includes(lf.path));
    const merged = [...serverFiles].filter(sf => !legacyPaths.includes(sf.path));
    
    for (const lf of cleanLocalOverride) {
      const idx = merged.findIndex(f => f.path === lf.path);
      if (idx !== -1) {
        merged[idx] = lf; // update with locally modified version
      } else {
        merged.push(lf); // add new custom files
      }
    }
    
    S.files = merged.filter(f => !f.is_deleted);
    localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
    
    renderFileTree();
    
    // Do not open default files automatically on load so that the welcome page stays active
    // if (!S.tabs.length && S.files.length) {
    //   const defaultFile = S.files.find(f => f.type === 'file');
    //   if (defaultFile) openFileInTab(defaultFile.path);
    // }
  } catch(e) {
    console.error('loadFiles error:', e);
  }
}

const SVG_MONGO_LEAF = `<svg viewBox="0 0 16 16" width="14" height="14" style="margin-right:6px;flex-shrink:0"><path fill="#47a248" d="M8 1s-4.5 4.5-4.5 8.5C3.5 12 5.5 15 8 15s4.5-3 4.5-5.5C12.5 5.5 8 1 8 1zm0 12.5c-1.5 0-2.5-1.5-2.5-3 0-2.5 2.5-6 2.5-6s2.5 3.5 2.5 6c0 1.5-1 3-2.5 3z"/></svg>`;
const SVG_FOLDER_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="#a7a7a7" style="margin-right:6px;flex-shrink:0"><path d="M14 4.5h-5.5L7 2.5H2a1.5 1.5 0 0 0-1.5 1.5v8c0 .8.7 1.5 1.5 1.5h12c.8 0 1.5-.7 1.5-1.5v-6c0-.8-.7-1.5-1.5-1.5z"/></svg>`;
const SVG_FILE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="#a7a7a7" style="margin-right:6px;flex-shrink:0"><path d="M9 1H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V6l-5-5zM8 5V2.5L11.5 5H8z"/></svg>`;

function renderFileTree() {
  const container = document.getElementById('q-list');
  if (!S.files.length) {
    container.innerHTML = `<div style="padding:8px 12px;color:var(--text3)">No query files.</div>`;
    return;
  }
  
  // Sort: folders first, then files
  const sorted = [...S.files].sort((a,b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  
  container.innerHTML = sorted.map(f => {
    let icon = f.type === 'folder' ? SVG_FOLDER_ICON : SVG_FILE_ICON;
    if (f.type === 'file' && f.name.endsWith('.mongo')) {
      icon = SVG_MONGO_LEAF;
    }
    const indentClass = f.path.includes('/') ? 'style="padding-left:36px"' : '';
    return `
      <div class="file-item ${f.path === S.activeFile ? 'active' : ''}" 
           data-path="${esc(f.path)}"
           ${indentClass}
           onclick="openFileInTab('${f.path}')"
           oncontextmenu="handleFileContextMenu(event, '${f.path}')">
        <span class="file-icon" style="display:flex; align-items:center">${icon}</span>
        <span>${esc(f.name)}</span>
      </div>
    `;
  }).join('');
}

function openFileInTab(path) {
  const file = S.files.find(f => f.path === path);
  if (!file || file.type === 'folder') return;
  
  S.activeFile = path;
  if (!S.tabs.includes(path)) {
    S.tabs.push(path);
    createTabElement(file);
  }
  
  editor.setValue(file.content);
  
  // Dynamically update workspace language and views based on file extension
  let lang = 'mongodb';
  let cmMode = 'javascript';
  let langIndicator = 'Mongo Shell';
  
  const lowerPath = file.path.toLowerCase();
  if (lowerPath.endsWith('.py')) {
    lang = 'python';
    cmMode = 'python';
    langIndicator = 'Python 3';
  } else if (lowerPath.endsWith('.cpp')) {
    lang = 'cpp';
    cmMode = 'text/x-c++src';
    langIndicator = 'C++';
  } else if (lowerPath.endsWith('.c')) {
    lang = 'c';
    cmMode = 'text/x-c++src';
    langIndicator = 'C';
  } else if (lowerPath.endsWith('.java')) {
    lang = 'java';
    cmMode = 'text/x-java';
    langIndicator = 'Java';
  }
  
  const langSelect = document.getElementById('workspace-lang-select');
  if (langSelect) {
    langSelect.value = lang;
  }
  
  const langIndicatorEl = document.getElementById('sb-lang-indicator');
  if (langIndicatorEl) {
    langIndicatorEl.textContent = langIndicator;
  }

  // Switch workspace console views: MongoDB tabs/Inspector vs Unified Terminal
  const isMongo = lang === 'mongodb';
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

  // Toggle console views
  const conTabs = document.getElementById('console-tabs');
  const conSubTabs = document.getElementById('console-sub-tabs');
  const treeView = document.getElementById('tree-view');
  const rawView = document.getElementById('raw-view');
  const outputView = document.getElementById('output-view');
  const terminalView = document.getElementById('terminal-view');

  if (isMongo) {
    if (conTabs) conTabs.style.display = 'flex';
    if (conSubTabs) conSubTabs.style.display = 'flex';
    if (terminalView) terminalView.style.display = 'none';
    
    // Restore default selected result view
    const isOutputActive = S.conTab === 'output';
    if (treeView) treeView.style.display = (isOutputActive && S.resultView === 'tree') ? 'flex' : 'none';
    if (rawView) rawView.style.display = (isOutputActive && S.resultView === 'raw') ? 'block' : 'none';
    if (outputView) outputView.style.display = (!isOutputActive || S.resultView === 'out') ? 'block' : 'none';
  } else {
    if (conTabs) conTabs.style.display = 'none';
    if (conSubTabs) conSubTabs.style.display = 'none';
    if (treeView) treeView.style.display = 'none';
    if (rawView) rawView.style.display = 'none';
    if (outputView) outputView.style.display = 'none';
    if (terminalView) terminalView.style.display = 'flex';
  }

  if (editor) {
    editor.setOption('mode', cmMode);
    setTimeout(() => editor.refresh(), 50);
  }

  S.activeCollection = inferCollectionFromQuery(file.content) || S.activeCollection;
  document.getElementById('sb-coll').textContent = S.activeCollection;
  loadSchema(S.activeCollection);
  
  // Update active states
  renderFileTree();
  updateActiveTabStyle();
  showView('ide');
}

function inferCollectionFromQuery(q) {
  const m = q.match(/db\.([A-Za-z0-9_]+)\./);
  return m ? m[1] : null;
}

function createTabElement(file) {
  const tabbar = document.getElementById('tabbar');
  const addBtn = tabbar.querySelector('.tab-add');
  
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.id = `tab-${escId(file.path)}`;
  tab.innerHTML = `
    <span class="tab-dot"></span>
    <span>${esc(file.name)}</span>
    <button class="tab-close" onclick="closeTab('${file.path}', event)">×</button>
  `;
  tab.onclick = () => openFileInTab(file.path);
  tabbar.insertBefore(tab, addBtn);
}

function closeTab(path, event) {
  if (event) event.stopPropagation();
  
  const tabEl = document.getElementById(`tab-${escId(path)}`);
  if (tabEl) tabEl.remove();
  
  S.tabs = S.tabs.filter(t => t !== path);
  
  if (S.activeFile === path) {
    if (S.tabs.length) {
      openFileInTab(S.tabs[S.tabs.length - 1]);
    } else {
      S.activeFile = null;
      editor.setValue('');
    }
  }
  renderFileTree();
}

function updateActiveTabStyle() {
  document.querySelectorAll('.tab').forEach(el => {
    const isAct = el.id === `tab-${escId(S.activeFile)}`;
    el.classList.toggle('active', isAct);
  });
}

function saveQuery() {
  if (!S.activeFile) return;
  const content = editor.getValue();
  const file = S.files.find(f => f.path === S.activeFile);
  if (!file) return;
  
  file.content = content;
  
  // Save locally in browser
  localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
  const tabEl = document.getElementById(`tab-${escId(S.activeFile)}`);
  if (tabEl) tabEl.classList.remove('dirty');
  logOutput(`[info] Saved ${file.name} to local storage`);
  
  // Try saving on server
  fetchAPI('/api/files/save', {
    method: 'POST',
    body: JSON.stringify({ path: file.path, content })
  }).then(r => {
    if (r.saved_on_server) {
      logOutput(`[success] File ${file.name} successfully written to workspace disk.`);
    }
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// CRUD FILE SYSTEM DIALOGS
// ═══════════════════════════════════════════════════════════════════
function createNewQueryFile(event) {
  if (event) event.stopPropagation();
  renderInlineCreateInput('file');
}

function createNewFolder(event) {
  if (event) event.stopPropagation();
  renderInlineCreateInput('folder');
}

function renderInlineCreateInput(type) {
  // First make sure the file list container is expanded
  if (!S.filesOpen) {
    toggleFileSection();
  }
  
  const container = document.getElementById('q-list');
  // Check if an input is already showing
  if (document.getElementById('inline-create-input')) return;
  
  const tempDiv = document.createElement('div');
  tempDiv.className = 'file-item inline-create-container';
  tempDiv.style.paddingLeft = '28px';
  tempDiv.style.background = 'var(--hl2)';
  
  const icon = type === 'folder' ? SVG_FOLDER_ICON : SVG_FILE_ICON;
  
  tempDiv.innerHTML = `
    <span class="file-icon" style="margin-right: 6px; display: flex; align-items: center">${icon}</span>
    <input id="inline-create-input" 
           placeholder="${type === 'folder' ? 'Folder Name' : 'filename.mongo'}"
           style="flex: 1; background: #2d2d2d; border: 1px solid #007acc; border-radius: 2px; color: #fff; font-size: 12px; outline: none; padding: 2px 4px; font-family: inherit; width: 100%" />
  `;
  
  // Insert at the top of the file list
  container.insertBefore(tempDiv, container.firstChild);
  
  const inputEl = document.getElementById('inline-create-input');
  inputEl.focus();
  
  let finished = false;
  const handleFinish = () => {
    if (finished) return;
    finished = true;
    const name = inputEl.value.trim();
    if (name) {
      if (type === 'file') {
        let filename = name;
        const validExtensions = ['.mongo', '.json', '.cpp', '.java', '.py', '.c'];
        const hasExt = validExtensions.some(ext => filename.toLowerCase().endsWith(ext));
        if (!hasExt) {
          filename += '.mongo';
        }
        
        // Check duplicate
        if (S.files.some(f => f.path === filename)) {
          alert('File already exists.');
          renderFileTree();
          return;
        }
        
        let starter = `// MongoDB Query: ${filename}\n\ndb.users.find({})\n`;
        if (filename.endsWith('.py')) {
          starter = `# Python 3 script\nprint("Hello World")\n`;
        } else if (filename.endsWith('.cpp')) {
          starter = `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello World" << endl;\n    return 0;\n}\n`;
        } else if (filename.endsWith('.c')) {
          starter = `#include <stdio.h>\n\nint main() {\n    printf("Hello World\\n");\n    return 0;\n}\n`;
        } else if (filename.endsWith('.java')) {
          const baseName = filename.replace(/\.java$/, '');
          starter = `public class ${baseName} {\n    public static void main(String[] args) {\n        System.out.println("Hello from ${baseName}!");\n    }\n}\n`;
        }

        const fileObj = {
          name: filename,
          path: filename,
          content: starter,
          type: 'file'
        };
        S.files.push(fileObj);
        localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
        renderFileTree();
        openFileInTab(fileObj.path);
        
        fetchAPI('/api/files/create', {
          method: 'POST',
          body: JSON.stringify({ path: fileObj.path, is_folder: false })
        }).catch(() => {});
      } else {
        // Folder
        if (S.files.some(f => f.path === name)) {
          alert('Folder already exists.');
          renderFileTree();
          return;
        }
        
        const folderObj = {
          name: name,
          path: name,
          type: 'folder',
          content: ''
        };
        S.files.push(folderObj);
        localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
        renderFileTree();
        
        fetchAPI('/api/files/create', {
          method: 'POST',
          body: JSON.stringify({ path: folderObj.path, is_folder: true })
        }).catch(() => {});
      }
    } else {
      renderFileTree();
    }
  };
  
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFinish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renderFileTree();
    }
  });
  
  // Clean up on blur if empty
  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.getElementById('inline-create-input') && !finished) {
        handleFinish();
      }
    }, 150);
  });
}

function collapseAllFiles(event) {
  if (event) event.stopPropagation();
  toggleFileSection();
}

function handleFileContextMenu(event, path) {
  event.preventDefault();
  event.stopPropagation();
  
  // Remove any existing context menus
  removeCustomContextMenu();
  
  const menu = document.createElement('div');
  menu.id = 'custom-file-context-menu';
  menu.style.position = 'fixed';
  menu.style.top = event.clientY + 'px';
  menu.style.left = event.clientX + 'px';
  menu.style.background = '#252526';
  menu.style.border = '1px solid #454545';
  menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
  menu.style.borderRadius = '3px';
  menu.style.padding = '4px 0';
  menu.style.zIndex = '1000';
  menu.style.minWidth = '120px';
  
  menu.innerHTML = `
    <div class="ctx-item" style="padding: 6px 12px; cursor: pointer; color: #ccc; font-size: 12px; display: flex; align-items: center; gap: 8px" onclick="inlineRenameFile('${path}')">
      <span style="font-size: 12px">✏️</span> Rename
    </div>
    <div class="ctx-item" style="padding: 6px 12px; cursor: pointer; color: #f48771; font-size: 12px; display: flex; align-items: center; gap: 8px" onclick="inlineDeleteFile('${path}')">
      <span style="font-size: 12px">🗑️</span> Delete
    </div>
  `;
  
  // Style hover effect
  let style = document.getElementById('ctx-hover-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ctx-hover-style';
    style.textContent = `
      .ctx-item:hover {
        background: #094771 !important;
        color: #fff !important;
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(menu);
  
  // Close menu when clicking outside
  const closeHandler = () => {
    removeCustomContextMenu();
    document.removeEventListener('click', closeHandler);
  };
  setTimeout(() => {
    document.addEventListener('click', closeHandler);
  }, 50);
}

function removeCustomContextMenu() {
  const menu = document.getElementById('custom-file-context-menu');
  if (menu) menu.remove();
  const style = document.getElementById('ctx-hover-style');
  if (style) style.remove();
}

function inlineRenameFile(path) {
  removeCustomContextMenu();
  const file = S.files.find(f => f.path === path);
  if (!file) return;
  
  const items = document.querySelectorAll('.file-item');
  let targetEl = null;
  for (const item of items) {
    if (item.getAttribute('data-path') === path) {
      targetEl = item;
      break;
    }
  }
  
  if (!targetEl) return;
  
  const currentName = file.name;
  const icon = targetEl.querySelector('.file-icon').innerHTML;
  
  targetEl.innerHTML = `
    <span class="file-icon" style="margin-right: 6px; display: flex; align-items: center">${icon}</span>
    <input id="inline-rename-input" 
           value="${esc(currentName)}"
           style="flex: 1; background: #2d2d2d; border: 1px solid #007acc; border-radius: 2px; color: #fff; font-size: 12px; outline: none; padding: 2px 4px; font-family: inherit; width: 100%" />
  `;
  
  const inputEl = document.getElementById('inline-rename-input');
  inputEl.focus();
  inputEl.select();
  
  let finished = false;
  const handleRenameFinish = () => {
    if (finished) return;
    finished = true;
    const newName = inputEl.value.trim();
    if (newName && newName !== currentName) {
      const oldPath = file.path;
      file.name = newName;
      file.path = newName;
      
      const tabIdx = S.tabs.indexOf(oldPath);
      if (tabIdx !== -1) S.tabs[tabIdx] = file.path;
      if (S.activeFile === oldPath) S.activeFile = file.path;
      
      // Update Tab element ID and label directly
      const tabEl = document.getElementById(`tab-${escId(oldPath)}`);
      if (tabEl) {
        tabEl.id = `tab-${escId(file.path)}`;
        const textSpan = tabEl.querySelector('span:not(.tab-dot)');
        if (textSpan) textSpan.textContent = file.name;
        // Re-bind onclick
        tabEl.onclick = () => openFileInTab(file.path);
        const closeBtn = tabEl.querySelector('.tab-close');
        if (closeBtn) closeBtn.onclick = (e) => closeTab(file.path, e);
      }
      
      localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
      renderFileTree();
      
      fetchAPI('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ old_path: oldPath, new_path: file.path })
      }).catch(() => {});
    } else {
      renderFileTree();
    }
  };
  
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameFinish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renderFileTree();
    }
  });
  
  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (!finished) handleRenameFinish();
    }, 150);
  });
}

function inlineDeleteFile(path) {
  removeCustomContextMenu();
  deleteActiveQueryFile(path);
}

function deleteActiveQueryFile(path) {
  if (!confirm(`Are you sure you want to delete '${path}'?`)) return;
  
  closeTab(path);
  S.files = S.files.filter(f => f.path !== path);
  localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
  renderFileTree();
  
  fetchAPI('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ path })
  }).catch(() => {});
}
