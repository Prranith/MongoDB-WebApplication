// ═══════════════════════════════════════════════════════════════════
// FILES WORKSPACE MANAGEMENT (LocalStorage Sync)
// ═══════════════════════════════════════════════════════════════════
async function loadFiles() {
  try {
    // Read local override from localStorage to ensure 100% private, client-side files
    let localFiles = JSON.parse(localStorage.getItem('mongosandbox_files') || '[]');
    
    // Filter out legacy files
    const legacyPaths = ['01_find_paid.mongo', '02_aggregate_pipeline.mongo', 'kishor.mongo'];
    localFiles = localFiles.filter(lf => !legacyPaths.includes(lf.path));

    // Keep the workspace empty until the user explicitly creates a file.
    
    S.files = localFiles;
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

const ICON_ROOT = '/assets/icons/material/';
const SVG_MONGO_LEAF = `<img class="file-type-icon" src="${ICON_ROOT}database.svg" alt="MongoDB" title="MongoDB">`;
const SVG_FOLDER_ICON = `<img class="file-type-icon" src="${ICON_ROOT}folder-base.svg" alt="Folder">`;
const SVG_FILE_ICON = `<img class="file-type-icon" src="${ICON_ROOT}document.svg" alt="File">`;
function fileIconLegacy(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const marks = {
    js: '<path fill="#1e1e1e" d="M5 11.7c.4.7.9 1 1.6 1 .6 0 .9-.3.9-.7 0-.4-.3-.6-1-.9l-.3-.1c-1-.4-1.5-1-1.5-1.9 0-1 .8-1.7 1.9-1.7.9 0 1.5.4 1.9 1.2l-1 .6c-.2-.4-.5-.6-.9-.6-.3 0-.5.2-.5.5 0 .3.2.4.8.7l.3.1c1.1.5 1.7 1 1.7 2.1 0 1.2-.9 1.9-2.3 1.9-1.2 0-2-.6-2.4-1.5zM9.6 7.5h4v1.1h-1.4v4h-1.2v-4H9.6z"/>',
    mongo: '<path fill="#fff" d="M10.1 2.7c-.9 1.8-2.2 3.3-2.2 5.7 0 2.2 1.1 3.6 1.4 5.1.2-1.2.8-2.2 1.1-3.5.5-2.4.1-4.7-.3-7.3z"/>',
    sql: '<path fill="#fff" d="M5 6h6v1H5zm0 2h6v1H5zm0 2h4v1H5z"/><path fill="#fff" d="M11 11h2v1h-2z"/>',
    sqlite: '<path fill="#12343b" d="M5 6h6v1H5zm0 2h6v1H5zm0 2h4v1H5z"/>',
    json: '<path fill="#1e1e1e" d="M7 4.5c-.8 0-1.2.5-1.2 1.3v.8c0 .5-.2.7-.7.7v1c.5 0 .7.2.7.7v.8c0 .8.4 1.3 1.2 1.3v-.9c-.3 0-.4-.2-.4-.6v-.8c0-.6-.2-.9-.6-1 .4-.1.6-.4.6-1v-.8c0-.4.1-.6.4-.6zm2 0v.9c.3 0 .4.2.4.6v.8c0 .6.2.9.6 1-.4.1-.6.4-.6 1v.8c0 .4-.1.6-.4.6v.9c.8 0 1.2-.5 1.2-1.3v-.8c0-.5.2-.7.7-.7v-1c-.5 0-.7-.2-.7-.7v-.8c0-.8-.4-1.3-1.2-1.3z"/>',
    py: '<path fill="#ffd343" d="M8 3.5H6.2c-1.2 0-1.8.6-1.8 1.8v1.8h2.8V8H4.4v1.2H8c1.2 0 1.8-.6 1.8-1.8V5.3C9.8 4.1 9.2 3.5 8 3.5zm-1.2 1.3h1v1h-1z"/><path fill="#3776ab" d="M8 12.5h1.8c1.2 0 1.8-.6 1.8-1.8V8.9H8.8V8H12v-1.2H8c-1.2 0-1.8.6-1.8 1.8v2.1c0 1.2.6 1.8 1.8 1.8zm1.2-1.3h-1v-1h1z"/>',
    cpp: '<path fill="#fff" d="M5.7 7.3a2.7 2.7 0 1 0 0 5.4c.8 0 1.5-.3 2- .9l-.8-.7c-.3.3-.7.5-1.2.5a1.6 1.6 0 1 1 0-3.2c.5 0 .9.2 1.2.5l.8-.7c-.5-.6-1.2-.9-2-.9zm4.5 0h-1v1.9H8.3v1h.9v1.9h1v-1.9h1v-1h-1z"/>',
    c: '<path fill="#fff" d="M7 7.3a2.7 2.7 0 1 0 0 5.4c.8 0 1.5-.3 2-.9l-.8-.7c-.3.3-.7.5-1.2.5a1.6 1.6 0 1 1 0-3.2c.5 0 .9.2 1.2.5l.8-.7c-.5-.6-1.2-.9-2-.9z"/>',
    java: '<path fill="#fff" d="M8.8 3.5c1.1 1-.2 1.7-.3 2.4-.1.6.7 1 .7 1S7 6.6 7 5.7c0-.7 1.2-1.3 1.8-2.2zM5.2 9.7c.7.4 1.6.6 2.8.6s2.1-.2 2.8-.6c-.1.9-1.1 1.5-2.8 1.5s-2.7-.6-2.8-1.5zM6 12c.6.3 1.3.4 2 .4s1.4-.1 2-.4c-.2.6-.9.9-2 .9s-1.8-.3-2-.9z"/>'
  };
  const colors = { mongo:'#47a248', js:'#f7df1e', sql:'#cc7832', sqlite:'#80cbc4', json:'#cbcb41', py:'#3776ab', cpp:'#519aba', c:'#519aba', java:'#b07219' };
  const color = colors[ext] || '#a7a7a7';
  return `<svg class="file-type-icon" viewBox="0 0 16 16" aria-label="${ext || 'file'}" role="img"><path fill="${color}" d="M2 1h8l4 4v10H2z"/><path fill="#fff" opacity=".9" d="M10 1v4h4z"/>${marks[ext] || '<path fill="#fff" d="M5 7h6v1H5zm0 2h6v1H5z"/>'}</svg>`;
}

function getFileIconName(filename) {
  const base = String(filename || '').split('/').pop().toLowerCase();
  const special = { dockerfile: 'docker', makefile: 'document', 'package.json': 'json', 'package-lock.json': 'json', 'pnpm-lock.yaml': 'yaml', 'readme.md': 'markdown', license: 'document' };
  if (special[base]) return special[base];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
  const map = { mongo:'database', js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', tsx:'typescript', mts:'typescript', cts:'typescript', c:'c', h:'h', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'hpp', java:'java', py:'python', pyw:'python', pyi:'python', cs:'csharp', go:'go', rs:'rust', swift:'swift', kt:'kotlin', kts:'kotlin', php:'php', rb:'ruby', dart:'dart', scala:'scala', lua:'lua', r:'r', ex:'elixir', exs:'elixir', zig:'zig', html:'html', htm:'html', css:'css', scss:'css', sass:'css', less:'css', json:'json', jsonc:'json', json5:'json', xml:'xml', yaml:'yaml', yml:'yaml', md:'markdown', markdown:'markdown', sh:'console', bash:'console', zsh:'console', fish:'console', ps1:'powershell', sql:'database', sqlite:'database', sqlite3:'database', db:'database', db3:'database', graphql:'graphql', gql:'graphql', vue:'vue', svelte:'svelte', bat:'console', toml:'toml', ini:'settings', env:'document', asm:'assembly' };
  return map[ext] || 'document';
}

// Local official Material Icon Theme SVG; no runtime network dependency.
function fileIcon(name) {
  const icon = getFileIconName(name);
  return `<img class="file-type-icon" src="${ICON_ROOT}${icon}.svg" alt="${icon} file" title="${icon}">`;
}

function toggleFolder(path) {
  const folder = S.files.find(f => f.type === 'folder' && f.path === path);
  if (!folder) return;
  S.activeFolder = path;
  S.activeFile = null;
  folder.expanded = folder.expanded === false;
  localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
  renderFileTree();
}

function isFileVisible(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = S.files.find(f => f.type === 'folder' && f.path === parts.slice(0, i).join('/'));
    if (parent && parent.expanded === false) return false;
  }
  return true;
}

function renderFileTree() {
  const container = document.getElementById('q-list');
  if (!S.files.length) {
    container.innerHTML = `<div style="padding:8px 12px;color:var(--text3)">No files.</div>`;
    return;
  }
  
  // Sort: folders first, then files
  const sorted = [...S.files].sort((a,b) => a.path.localeCompare(b.path, undefined, {numeric:true}));
  
  container.innerHTML = sorted.map(f => {
    let icon = f.type === 'folder'
      ? `<img class="file-type-icon" src="${ICON_ROOT}${f.expanded === false ? 'folder-base.svg' : 'folder-base-open.svg'}" alt="Folder">`
      : fileIcon(f.name);
    if (f.type === 'file' && f.name.toLowerCase().endsWith('.mongo')) icon = SVG_MONGO_LEAF;
    const depth = f.path.split('/').length - 1;
    if (!isFileVisible(f.path)) return '';
    const indentClass = `style="padding-left:${28 + depth * 18}px"`;
    const isFolder = f.type === 'folder';
    const isActive = f.path === (S.activeFile || S.activeFolder);
    const folderArrow = isFolder ? `<span class="folder-chevron">${f.expanded === false ? '›' : '⌄'}</span>` : '';
    return `
      <div class="file-item ${isActive ? 'active' : ''}"
           data-path="${esc(f.path)}"
           ${indentClass}
           onclick="${isFolder ? `toggleFolder('${f.path}')` : `openFileInTab('${f.path}')` }"
           oncontextmenu="handleFileContextMenu(event, '${f.path}')">
        ${folderArrow}<span class="file-icon" style="display:flex; align-items:center">${icon}</span>
        <span>${esc(f.name)}</span>
      </div>
    `;
  }).join('');
}

function openFileInTab(path) {
  const file = S.files.find(f => f.path === path);
  if (!file || file.type === 'folder') return;
  
  S.activeFile = path;
  // New items are created in the selected file's containing folder.
  const parentParts = path.split('/');
  S.activeFolder = null;
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
  } else if (lowerPath.endsWith('.sql')) {
    lang = 'sql'; cmMode = 'text/x-sql'; langIndicator = 'SQL';
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
  if (window.updateWorkspaceConsoleLayout) {
    window.updateWorkspaceConsoleLayout(lang);
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
    <span class="tab-file-icon">${fileIcon(file.name)}</span>
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
  
  const selectedParent = S.activeFolder || (S.activeFile && S.activeFile.includes('/') ? S.activeFile.split('/').slice(0, -1).join('/') : '');
  const selectedFolder = selectedParent ? S.files.find(f => f.type === 'folder' && f.path === selectedParent) : null;
  if (selectedFolder && selectedFolder.expanded === false) selectedFolder.expanded = true;
  const createDepth = selectedParent ? selectedParent.split('/').length : 0;
  const tempDiv = document.createElement('div');
  tempDiv.className = 'file-item inline-create-container';
  tempDiv.style.paddingLeft = `${28 + createDepth * 18}px`;
  tempDiv.style.background = 'var(--hl2)';
  
  const icon = type === 'folder' ? SVG_FOLDER_ICON : SVG_FILE_ICON;
  tempDiv.innerHTML = `
    <span class="file-icon" style="margin-right: 6px; display: flex; align-items: center">${icon}</span>
    <input id="inline-create-input" 
           placeholder="${type === 'folder' ? 'Folder Name' : 'New File (e.g. solution.cpp, query.js)'}"
           style="flex: 1; background: #2d2d2d; border: 1px solid #007acc; border-radius: 2px; color: #fff; font-size: 12px; outline: none; padding: 2px 4px; font-family: inherit; width: 100%" />
  `;
  
  // Insert directly inside the selected folder, like VS Code's inline create row.
  const folderRow = selectedParent && container.querySelector(`[data-path="${CSS.escape(selectedParent)}"]`);
  if (folderRow) folderRow.insertAdjacentElement('afterend', tempDiv);
  else container.insertBefore(tempDiv, container.firstChild);
  
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
        const targetPath = selectedParent ? `${selectedParent}/${filename}` : filename;
        // Preserve exactly what the user typed; never append an extension.
        
        // Check duplicate
        if (S.files.some(f => f.path === targetPath)) {
          alert('File already exists.');
          renderFileTree();
          return;
        }
        
        let starter = `// ${filename}\n`;
        if (filename.toLowerCase().endsWith('.py')) {
          starter = `# Python 3 script\nprint("Hello World")\n`;
        } else if (filename.toLowerCase().endsWith('.cpp')) {
          starter = `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello World" << endl;\n    return 0;\n}\n`;
        } else if (filename.toLowerCase().endsWith('.c')) {
          starter = `#include <stdio.h>\n\nint main() {\n    printf("Hello World\\n");\n    return 0;\n}\n`;
        } else if (filename.toLowerCase().endsWith('.java')) {
          const baseName = filename.replace(/\.java$/, '');
          starter = `public class ${baseName} {\n    public static void main(String[] args) {\n        System.out.println("Hello from ${baseName}!");\n    }\n}\n`;
        } else if (filename.toLowerCase().endsWith('.js')) {
          starter = `// JavaScript/MongoDB query\ndb.users.find({});\n`;
        } else if (filename.toLowerCase().endsWith('.sql')) {
          starter = `-- SQL query\nSELECT * FROM users LIMIT 10;\n`;
        }

        const fileObj = {
          name: filename,
          path: targetPath,
          content: starter,
          type: 'file'
        };
        S.files.push(fileObj);
        localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
        renderFileTree();
        openFileInTab(fileObj.path);
      } else {
        // Folder
        const folderPath = selectedParent ? `${selectedParent}/${name}` : name;
        if (S.files.some(f => f.path === folderPath)) {
          alert('Folder already exists.');
          renderFileTree();
          return;
        }
        
        const folderObj = {
          name: name,
          path: folderPath,
          type: 'folder',
          content: '',
          expanded: true
        };
        S.files.push(folderObj);
        localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
        renderFileTree();
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
}
