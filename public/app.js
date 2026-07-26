/* app.js
   Full VS Code-like state & UI logic for MongoSandbox
*/

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGS
// ═══════════════════════════════════════════════════════════════════
const _TYPE_ICONS = {
  "object":   "{}",
  "array":    "[]",
  "string":   '"a"',
  "number":   "123",
  "boolean":  "T/F",
  "null":     "nil",
  "date":     "📅",
  "objectid": "🆔",
  "unknown":  "?",
};

const _TYPE_COLORS = {
  "string":   "#ce9178",
  "number":   "#b5cea8",
  "boolean":  "#569cd6",
  "null":     "#858585",
  "date":     "#4ec9b0",
  "objectid": "#4ec9b0",
  "object":   "#858585",
  "array":    "#c586c0",
};

const COLL_ICONS = {
  users: '👤',
  orders: '📦',
  inventory: '🏭',
  shipments: '🚚',
  elite: '⭐'
};

const RELATIONS = {
  orders: [
    { field: "userId", type: "Many-to-One", to: "users.userId", desc: "Links the order to the customer profile who placed it." },
    { field: "items[].sku", type: "Many-to-One", to: "inventory.sku", desc: "Links each ordered item to its inventory stock profile." }
  ],
  shipments: [
    { field: "orderId", type: "One-to-One", to: "orders.orderId", desc: "Links the shipment details to the specific order being delivered." }
  ],
  users: [
    { field: "userId", type: "One-to-Many", to: "orders.userId", desc: "Bridges customer profiles to all orders they have placed." }
  ],
  inventory: [
    { field: "sku", type: "One-to-Many", to: "orders.items.sku", desc: "Maps product sku to line items ordered across the system." }
  ],
  elite: [
    { field: "userId", type: "Many-to-One", to: "users.userId", desc: "Links elite transaction to customer profile." }
  ]
};

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════
const S = {
  view: 'intro',
  sidePanel: 'explorer',
  sidebarOpen: true,
  inspectorOpen: true,
  activeCollection: 'users',
  collections: [],
  snippets: {},
  conTab: 'output',
  resultView: 'tree',
  lastData: null,
  lastRaw: '',
  files: [], // { name, path, content, type: 'file'/'folder' }
  activeFile: null, // path of currently open file
  tabs: [], // paths of open files
  history: [], // query runs
  dbRootOpen: true,
  filesOpen: true,
  outlineOpen: false,
  timelineOpen: false,
  settings: {},
};

let editor;

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

  // Polling metrics on welcome screen
  setInterval(recordLaunch, 3000);

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

// ═══════════════════════════════════════════════════════════════════
// API CORE
// ═══════════════════════════════════════════════════════════════════
async function fetchAPI(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  return r.json();
}

function getClientId() {
  let cid = localStorage.getItem('mongosandbox_client_id');
  if (!cid) {
    cid = 'c_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
    localStorage.setItem('mongosandbox_client_id', cid);
  }
  return cid;
}

async function recordLaunch() {
  try {
    const d = await fetchAPI('/api/analytics/launch', {
      method: 'POST',
      body: JSON.stringify({ client_id: getClientId() })
    });
    document.getElementById('stat-active').textContent = d.active_users ?? '—';
    document.getElementById('stat-visited').textContent = d.total_visits ?? '—';
  } catch(e) {}

  startHeartbeatPolling();
  initParticles();
}

let heartbeatTimer = null;
function startHeartbeatPolling() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    const intro = document.getElementById('intro-panel');
    const cid = getClientId();
    if (intro && intro.classList.contains('active')) {
      try {
        const d = await fetchAPI(`/api/analytics?client_id=${cid}`);
        document.getElementById('stat-active').textContent = d.active_users ?? '—';
        document.getElementById('stat-visited').textContent = d.total_visits ?? '—';
      } catch(e) {}
    } else {
      try {
        await fetch('/api/analytics/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: cid })
        });
      } catch(e) {}
    }
  }, 30000);
}

function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  let width = canvas.offsetWidth;
  let height = canvas.offsetHeight;
  canvas.width = width;
  canvas.height = height;

  window.addEventListener('resize', () => {
    if (!canvas) return;
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;
  });

  const particles = [];
  const particleCount = Math.min(60, Math.floor((width * height) / 15000));
  const connectionDistance = 110;
  const mouse = { x: null, y: null, radius: 150 };

  const intro = document.getElementById('intro-panel');
  if (intro) {
    intro.addEventListener('mousemove', (e) => {
      const rect = intro.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    });
    intro.addEventListener('mouseleave', () => {
      mouse.x = null;
      mouse.y = null;
    });
  }

  class Particle {
    constructor() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.vx = (Math.random() - 0.5) * 0.5;
      this.vy = (Math.random() - 0.5) * 0.5;
      this.radius = Math.random() * 2 + 1;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;

      if (this.x < 0 || this.x > width) this.vx *= -1;
      if (this.y < 0 || this.y > height) this.vy *= -1;

      if (mouse.x !== null && mouse.y !== null) {
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < mouse.radius) {
          const force = (mouse.radius - dist) / mouse.radius;
          const angle = Math.atan2(dy, dx);
          this.x += Math.cos(angle) * force * 2;
          this.y += Math.sin(angle) * force * 2;
        }
      }
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 237, 100, 0.4)';
      ctx.fill();
    }
  }

  for (let i = 0; i < particleCount; i++) {
    particles.push(new Particle());
  }

  function animate() {
    if (intro && !intro.classList.contains('active')) {
      requestAnimationFrame(animate);
      return;
    }

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < particles.length; i++) {
      particles[i].update();
      particles[i].draw();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < connectionDistance) {
          const alpha = (1 - dist / connectionDistance) * 0.15;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 237, 100, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(animate);
  }

  animate();
}

async function loadCollections() {
  try {
    const d = await fetchAPI('/api/collections');
    S.collections = d.collections || [];
    renderDbTree();
    if (S.collections.length && !S.activeCollection) {
      setActiveCollection(S.collections[0].name);
    }
  } catch(e) {}
}

async function loadSnippets() {
  try {
    const d = await fetchAPI('/api/snippets');
    S.snippets = d.snippets || {};
    renderSnippetTree();
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════
// VIEWS SWITCHING
// ═══════════════════════════════════════════════════════════════════
function showView(name) {
  S.view = name;
  const ide = document.getElementById('ide-panel');
  const intro = document.getElementById('intro-panel');
  if (name === 'intro') {
    ide.style.display = 'none';
    intro.classList.add('active');
    
    // Set welcome icon active, others inactive
    document.getElementById('act-welcome')?.classList.add('active');
    ['files', 'db', 'history', 'snippets', 'search'].forEach(p => {
      document.getElementById(`act-${p}`)?.classList.remove('active');
    });
  } else {
    intro.classList.remove('active');
    ide.style.display = 'flex';
    
    // Set current side panel button to active
    document.getElementById('act-welcome')?.classList.remove('active');
    document.getElementById(`act-${S.sidePanel}`)?.classList.add('active');
    
    setTimeout(() => {
      editor.refresh();
      editor.focus();
    }, 50);
  }
}

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
  document.getElementById(`tab-${escId(S.activeFile)}`)?.classList.remove('dirty');
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
        if (!filename.endsWith('.mongo') && !filename.endsWith('.json')) {
          filename += '.mongo';
        }
        
        // Check duplicate
        if (S.files.some(f => f.path === filename)) {
          alert('File already exists.');
          renderFileTree();
          return;
        }
        
        const fileObj = {
          name: filename,
          path: filename,
          content: `// MongoDB Query: ${filename}\n\ndb.users.find({})\n`,
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

// ═══════════════════════════════════════════════════════════════════
// DATABASE TREE RENDERER
// ═══════════════════════════════════════════════════════════════════
const SVG_COLLECTION_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" style="margin-right:6px;flex-shrink:0" fill="#a7a7a7"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm2 1v2h8V4H4zm0 3v2h8V7H4zm0 3v2h8v-2H4z"/></svg>`;

function renderDbTree() {
  const container = document.getElementById('coll-list');
  container.innerHTML = S.collections.map(c => `
    <div class="tree-item ${c.name === S.activeCollection ? 'active' : ''}" 
         onclick="setActiveCollection('${c.name}')"
         style="display: flex; align-items: center">
      ${SVG_COLLECTION_ICON}
      <span>${c.name}</span>
      <span class="tree-badge">${c.count}</span>
    </div>
  `).join('');
  container.style.display = S.dbRootOpen ? 'block' : 'none';
}

function filterCollections(q) {
  document.querySelectorAll('.tree-item').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

function setActiveCollection(name) {
  S.activeCollection = name;
  document.getElementById('sb-coll').textContent = name;
  
  if (editor) {
    editor.setValue(`db.${name}.find({})`);
  }
  
  renderDbTree();
  loadSchema(name);
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA INSPECTOR
// ═══════════════════════════════════════════════════════════════════
function loadSchema(coll) {
  fetchAPI(`/api/schema/${coll}`).then(d => {
    renderInspector(coll, d.schema, d.count);
  });
}

function renderInspector(coll, schema, count) {
  const container = document.getElementById('insp-body');
  const rels = RELATIONS[coll] || [];
  
  let html = `
    <div class="insp-coll-name">${coll}</div>
    <div class="insp-coll-sub">collection · ${count} documents</div>
    <div class="insp-section">Fields Schema</div>
  `;
  
  for (const [field, types] of Object.entries(schema || {}).slice(0, 16)) {
    html += `
      <div class="insp-row">
        <span class="insp-field">${esc(field)}</span>
        <span class="insp-type">${types.join('|')}</span>
      </div>
    `;
  }
  
  if (rels.length) {
    html += `<div class="insp-section">Outbound Joins</div>`;
    for (const r of rels) {
      html += `
        <div class="insp-row" title="${esc(r.desc)}">
          <span class="insp-field">${esc(r.field)}</span>
          <span class="insp-type" style="color:var(--purple)">→ ${esc(r.to)}</span>
        </div>
      `;
    }
  }
  
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// SNIPPETS TREE RENDERER
// ═══════════════════════════════════════════════════════════════════
function renderSnippetTree() {
  const container = document.getElementById('snip-tree');
  let html = '';
  
  for (const [cat, snips] of Object.entries(S.snippets)) {
    html += `
      <div class="snip-cat" id="scat-${escId(cat)}">
        <div class="snip-cat-hdr" onclick="toggleSnippetCat('scat-${escId(cat)}')">
          <span class="arrow">▼</span>
          <span class="snip-cat-icon">📁</span>
          <span>${esc(cat)}</span>
        </div>
        <div class="snip-items">
    `;
    for (const s of snips) {
      html += `
        <div class="snip-item" title="${esc(s.description)}" onclick="insertSnippet(${JSON.stringify(s.body).replace(/"/g, '&quot;')})">
          <span class="snip-item-icon">◈</span>
          <span>${esc(s.name)}</span>
        </div>
      `;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;
}

function toggleSnippetCat(id) {
  document.getElementById(id)?.classList.toggle('collapsed');
}

function filterSnippets(q) {
  document.querySelectorAll('.snip-item').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

function insertSnippet(body) {
  editor.replaceSelection(body);
  editor.focus();
}

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
    const d = await fetchAPI('/api/query', {
      method: 'POST',
      body: JSON.stringify({ query: q, limit: limitVal })
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

// ═══════════════════════════════════════════════════════════════════
// SIDE PANEL TOGGLES
// ═══════════════════════════════════════════════════════════════════
function setSidePanel(name) {
  S.sidePanel = name;
  const panels = ['files', 'db', 'history', 'snippets', 'search'];
  panels.forEach(p => {
    const isAct = p === name;
    document.getElementById(`panel-${p}`)?.classList.toggle('active', isAct);
    document.getElementById(`act-${p}`)?.classList.toggle('active', isAct);
  });
  
  // Uncheck welcome page active state
  document.getElementById('act-welcome')?.classList.remove('active');
  
  // Update header title
  const title = PANEL_TITLES[name] || "Explorer";
  const titleEl = document.getElementById('sidebar-title');
  if (titleEl) titleEl.textContent = title;
  
  // Force show sidebar if collapsed
  if (!S.sidebarOpen) {
    toggleSidebar();
  }
  
  // Switch view to editor/ide when clicking other sidebar panels
  if (S.view !== 'ide') {
    showView('ide');
  }
  
  if (name === 'history') {
    renderHistoryPanel();
  }
}

function toggleSidebar() {
  S.sidebarOpen = !S.sidebarOpen;
  document.getElementById('sidebar').style.display = S.sidebarOpen ? 'flex' : 'none';
  document.getElementById('resizer').style.display = S.sidebarOpen ? 'block' : 'none';
  setTimeout(() => editor.refresh(), 50);
}

function toggleInspector() {
  S.inspectorOpen = !S.inspectorOpen;
  document.getElementById('inspector').style.display = S.inspectorOpen ? 'flex' : 'none';
  setTimeout(() => editor.refresh(), 50);
}

function toggleDbRoot() {
  S.dbRootOpen = !S.dbRootOpen;
  document.getElementById('coll-list').style.display = S.dbRootOpen ? 'block' : 'none';
  document.getElementById('db-root-arrow').textContent = S.dbRootOpen ? '▼' : '▶';
}

function toggleFileSection() {
  S.filesOpen = !S.filesOpen;
  document.getElementById('file-section').classList.toggle('collapsed', !S.filesOpen);
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW & MENU ACTIONS
// ═══════════════════════════════════════════════════════════════════
function toggleMenu(el) {
  event.stopPropagation();
  const wasOpen = el.classList.contains('open');
  closeMenus();
  if (!wasOpen) el.classList.add('open');
}

function closeMenus() {
  document.querySelectorAll('.wmenu.open').forEach(m => m.classList.remove('open'));
}

function formatQuery() {
  // Mock layout query formatter
  const val = editor.getValue();
  // Simply trim and fix tabs/spaces layout
  editor.setValue(val.trim());
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA OVERLAY MODAL (Fields + Relationships)
// ═══════════════════════════════════════════════════════════════════
function openModal(id) {
  document.getElementById(id).classList.add('open');
  if (id === 'schema-modal') {
    updateSchemaModal(S.activeCollection);
  } else if (id === 'settings-modal') {
    loadSettingsFromLocalStorage();
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function closeAllModals() {
  document.querySelectorAll('.modal-bg').forEach(el => el.classList.remove('open'));
}

function setModalTab(tab) {
  ['fields', 'rels'].forEach(t => {
    document.getElementById(`modal-tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`modal-${t}-view`).style.display = t === tab ? 'block' : 'none';
  });
}

function updateSchemaModal(collName) {
  document.getElementById('schema-coll-name').textContent = collName;
  const coll = S.collections.find(c => c.name === collName);
  document.getElementById('schema-coll-count').textContent = coll ? `${coll.count} documents` : '';
  
  fetchAPI(`/api/schema/${collName}`).then(d => {
    const tbody = document.getElementById('schema-tbody');
    tbody.innerHTML = Object.entries(d.schema || {}).map(([field, types], i) => `
      <tr>
        <td class="td-num">${i + 1}</td>
        <td class="td-field">${esc(field)}</td>
        <td class="td-type">${types.join('|')}</td>
        <td class="td-sample">${esc(getSampleValue(field, collName))}</td>
      </tr>
    `).join('');
  });
}

function getSampleValue(field, coll) {
  const samples = {
    '_id': '{"$oid": "603f7e2b..."}',
    'userId': '"usr_1001"',
    'orderId': '"ord_5001"',
    'shipmentId': '"shp_3001"',
    'sku': '"prod_9001"',
    'amount': '250',
    'totalAmount': '91.98',
    'status': '"PAID"',
    'qty': '2',
    'unitPrice': '45.99',
    'name': '"Ava Mitchell"',
    'email': '"ava.mitchell@example.com"',
    'demographics.age': '29',
    'demographics.gender': '"Female"',
    'payment.method': '"CREDIT_CARD"',
    'payment.status': '"PAID"'
  };
  return samples[field] || samples[field.split('.').pop()] || '—';
}

// ═══════════════════════════════════════════════════════════════════
// COMMAND PALETTE
// ═══════════════════════════════════════════════════════════════════
const CMDS = [
  { icon: '▶', label: 'Run MongoDB Query', key: 'Ctrl+Enter', action: runQuery },
  { icon: '📁', label: 'Toggle Side Explorer Panel', key: 'Ctrl+B', action: toggleSidebar },
  { icon: '📄', label: 'Create New Query File', key: 'Ctrl+N', action: createNewQueryFile },
  { icon: '💾', label: 'Save Current File changes', key: 'Ctrl+S', action: saveQuery },
  { icon: '⛁', label: 'Open Schema ER Details Dialog', key: 'F1', action: () => openModal('schema-modal') },
  { icon: '🗑', label: 'Clear Result Console Panels', action: clearConsole },
  { icon: '🔍', label: 'Toggle Right Inspector Widget', action: toggleInspector },
  { icon: '🏠', label: 'Go to Welcome Screen Dashboard', action: () => showView('intro') }
];

function openPalette() {
  document.getElementById('palette').classList.add('open');
  document.getElementById('palette-input').value = '';
  renderPalette('');
  document.getElementById('palette-input').focus();
}

function closePalette() {
  document.getElementById('palette').classList.remove('open');
}

function renderPalette(q) {
  const filtered = CMDS.filter(c => c.label.toLowerCase().includes(q.toLowerCase()));
  const container = document.getElementById('palette-list');
  
  container.innerHTML = filtered.map((c, i) => `
    <div class="p-item ${i === 0 ? 'sel' : ''}" onclick="executePaletteCommand(${i})">
      <span class="p-icon">${c.icon}</span>
      <span>${esc(c.label)}</span>
      ${c.key ? `<span class="p-key">${c.key}</span>` : ''}
    </div>
  `).join('');
  
  // Save commands list on window scope for invocation
  window._filteredCmds = filtered;
}

function executePaletteCommand(idx) {
  const cmd = window._filteredCmds[idx];
  if (cmd) {
    cmd.action();
    closePalette();
  }
}

// ═══════════════════════════════════════════════════════════════════
// SIDEBAR RESIZER INTERACTIVE
// ═══════════════════════════════════════════════════════════════════
function initResizer() {
  const handle = document.getElementById('resizer');
  const sidebar = document.getElementById('sidebar');
  let dragging = false, startX = 0, startW = 0;
  
  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(420, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  });
  
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      editor.refresh();
    }
  });
}

function initConsoleResizer() {
  const handle = document.getElementById('console-resizer');
  const consoleEl = document.getElementById('console');
  if (!handle || !consoleEl) return;
  
  let dragging = false, startY = 0, startH = 0;
  
  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = consoleEl.offsetHeight;
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = startY - e.clientY; // upwards drag increases height
    const h = Math.max(100, Math.min(window.innerHeight * 0.8, startH + dy));
    consoleEl.style.height = h + 'px';
  });
  
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
      if (editor) editor.refresh();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// HTML FORMAT ESCAPER
// ═══════════════════════════════════════════════════════════════════
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escId(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '_');
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS OPERATIONS
// ═══════════════════════════════════════════════════════════════════
function loadSettingsFromLocalStorage() {
  const defaults = {
    fontFamily: 'Consolas',
    fontSizeVal: 11,
    fontSizeUnit: 'pt',
    tabWidth: '4 spaces',
    maxResults: 10000,
    timeout: '30 s'
  };
  const saved = JSON.parse(localStorage.getItem('mongosandbox_settings') || '{}');
  S.settings = { ...defaults, ...saved };
  
  // Backwards compatibility for old S.settings.fontSize (e.g. "13 pt")
  if (saved.fontSize && !saved.fontSizeVal) {
    const valMatch = String(saved.fontSize).match(/\d+/);
    const unitMatch = String(saved.fontSize).match(/[a-zA-Z]+/);
    S.settings.fontSizeVal = valMatch ? parseInt(valMatch[0]) : 13;
    S.settings.fontSizeUnit = unitMatch ? unitMatch[0] : 'pt';
  }
  
  // Populate modal inputs
  document.getElementById('set-font-family').value = S.settings.fontFamily;
  document.getElementById('set-font-size-val').value = S.settings.fontSizeVal;
  document.getElementById('set-font-size-unit').value = S.settings.fontSizeUnit;
  document.getElementById('set-tab-width').value = S.settings.tabWidth;
  document.getElementById('set-max-results').value = S.settings.maxResults;
  document.getElementById('set-timeout').value = S.settings.timeout;
}

function saveSettings() {
  S.settings.fontFamily = document.getElementById('set-font-family').value;
  S.settings.fontSizeVal = parseInt(document.getElementById('set-font-size-val').value) || 11;
  S.settings.fontSizeUnit = document.getElementById('set-font-size-unit').value;
  S.settings.tabWidth = document.getElementById('set-tab-width').value;
  S.settings.maxResults = parseInt(document.getElementById('set-max-results').value) || 10000;
  S.settings.timeout = document.getElementById('set-timeout').value;
  
  // Maintain S.settings.fontSize for older dependencies
  S.settings.fontSize = S.settings.fontSizeVal + S.settings.fontSizeUnit;
  
  localStorage.setItem('mongosandbox_settings', JSON.stringify(S.settings));
  applySettings();
  closeModal('settings-modal');
  logOutput('[info] Editor and execution settings saved.');
}

function applySettings() {
  if (!editor) return;
  
  // Extract number from tabWidth (e.g. "4 spaces" -> 4)
  const tabMatch = String(S.settings.tabWidth || '4').match(/\d+/);
  const tabVal = tabMatch ? parseInt(tabMatch[0]) : 4;
  editor.setOption('tabSize', tabVal);
  editor.setOption('indentUnit', tabVal);
  
  // Apply styling dynamically (fontFamily, fontSize)
  let styleEl = document.getElementById('cm-dyn-settings-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cm-dyn-settings-style';
    document.head.appendChild(styleEl);
  }
  
  const sizeVal = (S.settings.fontSizeVal || 11) + (S.settings.fontSizeUnit || 'pt');
  
  styleEl.textContent = `
    .CodeMirror,
    .CodeMirror pre.CodeMirror-line,
    .CodeMirror pre.CodeMirror-line-like,
    .CodeMirror-linenumber,
    .CodeMirror-lines * {
      font-family: ${S.settings.fontFamily || 'Consolas'}, 'JetBrains Mono', monospace !important;
      font-size: ${sizeVal} !important;
    }
  `;
  editor.refresh();
}

// ═══════════════════════════════════════════════════════════════════
// MONGO INTELLISENSE AUTOCOMPLETION PROVIDER
// ═══════════════════════════════════════════════════════════════════
function setupMongoIntelliSense() {
  if (typeof CodeMirror === 'undefined') return;

  const SUGGESTIONS = [
    // Collections
    { text: "db.users.find({})", displayText: "db.users.find({}) — Collection: Customer accounts" },
    { text: "db.orders.find({})", displayText: "db.orders.find({}) — Collection: System orders" },
    { text: "db.inventory.find({})", displayText: "db.inventory.find({}) — Collection: Product stock" },
    { text: "db.shipments.find({})", displayText: "db.shipments.find({}) — Collection: Order delivery status" },
    { text: "db.elite.find({})", displayText: "db.elite.find({}) — Collection: Premium transactions" },
    
    // Methods
    { text: "find({})", displayText: "find({ filter }) — Query matching documents" },
    { text: "findOne({})", displayText: "findOne({ filter }) — Return single document" },
    { text: "aggregate([])", displayText: "aggregate([ pipeline ]) — Multi-stage aggregation" },
    { text: "countDocuments({})", displayText: "countDocuments({ filter }) — Count documents" },
    { text: "distinct(\"\")", displayText: "distinct(field) — Return distinct field values" },
    { text: "sort({ _id: -1 })", displayText: "sort({ field: 1/-1 }) — Sort query results" },
    { text: "limit(10)", displayText: "limit(n) — Limit maximum document count" },
    { text: "skip(0)", displayText: "skip(n) — Skip n documents" },
    { text: "insertOne({})", displayText: "insertOne(document) — Insert single document" },
    { text: "updateOne({}, {})", displayText: "updateOne(filter, update) — Update single document" },

    // Pipeline Stages
    { text: "$match: { status: \"PAID\" }", displayText: "$match — Filter documents by criteria" },
    { text: "$group: { _id: \"$field\", total: { $sum: \"$amount\" } }", displayText: "$group — Group & calculate metrics" },
    { text: "$project: { userId: 1, amount: 1, _id: 0 }", displayText: "$project — Select & format output fields" },
    { text: "$sort: { amount: -1 }", displayText: "$sort — Sort pipeline documents" },
    { text: "$limit: 10", displayText: "$limit — Limit pipeline documents" },
    { text: "$skip: 10", displayText: "$skip — Skip pipeline documents" },
    { text: "$lookup: { from: \"users\", localField: \"userId\", foreignField: \"userId\", as: \"user_info\" }", displayText: "$lookup — Perform collection join" },
    { text: "$unwind: \"$items\"", displayText: "$unwind — Deconstruct array field" },
    { text: "$addFields: { totalItems: { $size: \"$items\" } }", displayText: "$addFields — Add computed fields" },
    { text: "$facet: { byStatus: [{ $group: { _id: \"$status\", count: { $sum: 1 } } }] }", displayText: "$facet — Run multi-bucket aggregations" },

    // Operators
    { text: "$sum", displayText: "$sum — Calculate sum value" },
    { text: "$avg", displayText: "$avg — Calculate average value" },
    { text: "$min", displayText: "$min — Find minimum value" },
    { text: "$max", displayText: "$max — Find maximum value" },
    { text: "$gt", displayText: "$gt — Greater than ($gt)" },
    { text: "$gte", displayText: "$gte — Greater than or equal ($gte)" },
    { text: "$lt", displayText: "$lt — Less than ($lt)" },
    { text: "$lte", displayText: "$lte — Less than or equal ($lte)" },
    { text: "$in", displayText: "$in — Matches any in array ($in)" },
    { text: "$exists", displayText: "$exists — Check field existence ($exists)" }
  ];

  CodeMirror.registerHelper("hint", "javascript", function(cm) {
    const cur = cm.getCursor();
    const token = cm.getTokenAt(cur);
    const word = token.string.trim().toLowerCase();

    let list = SUGGESTIONS;
    if (word && word !== '.' && word !== '$') {
      list = SUGGESTIONS.filter(s => 
        s.text.toLowerCase().includes(word) || 
        s.displayText.toLowerCase().includes(word)
      );
    }

    return {
      list: list.map(s => ({ text: s.text, displayText: s.displayText })),
      from: CodeMirror.Pos(cur.line, token.start),
      to: CodeMirror.Pos(cur.line, token.end)
    };
  });
}
