// ═══════════════════════════════════════════════════════════════════
// SIDE PANEL TOGGLES
// ═══════════════════════════════════════════════════════════════════
function setSidePanel(name) {
  S.sidePanel = name;
  const panels = ['files', 'db', 'history', 'snippets', 'search'];
  panels.forEach(p => {
    const isAct = p === name;
    const panel = document.getElementById(`panel-${p}`);
    if (panel) panel.classList.toggle('active', isAct);
    const act = document.getElementById(`act-${p}`);
    if (act) act.classList.toggle('active', isAct);
  });
  
  // Uncheck welcome page active state
  const actWelcome = document.getElementById('act-welcome');
  if (actWelcome) actWelcome.classList.remove('active');
  
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
  const inspector = document.getElementById('inspector');
  if (inspector) inspector.style.display = S.inspectorOpen ? 'flex' : 'none';
  const btn = document.getElementById('btn-toggle-inspector');
  if (btn) {
    if (S.inspectorOpen) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
  setTimeout(() => { if (editor) editor.refresh(); }, 50);
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
  { icon: '🎯', label: 'Open Exam Portal (Mentor & Student)', action: () => window.ExamPortal && window.ExamPortal.showRoleSelection() },
  { icon: '📁', label: 'Toggle Side Explorer Panel', key: 'Ctrl+B', action: toggleSidebar },
  { icon: '📺', label: 'Toggle Console/Terminal Panel', action: toggleConsole },
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
    let h = startH + dy;
    
    // Allow dragging down to 0!
    if (h < 30) {
      h = 0;
    } else {
      h = Math.min(window.innerHeight * 0.8, h);
    }
    
    consoleEl.style.height = h + 'px';
    
    if (h === 0) {
      consoleEl.style.display = 'none';
      const btn = document.getElementById('btn-toggle-console');
      if (btn) btn.classList.remove('active');
    } else {
      consoleEl.style.display = 'flex';
      const btn = document.getElementById('btn-toggle-console');
      if (btn) btn.classList.add('active');
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
      if (editor) editor.refresh();
    }
  });
}

function toggleConsole() {
  const consoleEl = document.getElementById('console');
  const resizer = document.getElementById('console-resizer');
  if (!consoleEl) return;

  const isOpen = consoleEl.style.display !== 'none' && consoleEl.offsetHeight > 10;
  
  if (isOpen) {
    // Save current height if it's valid
    const currentH = consoleEl.offsetHeight;
    if (currentH > 20) {
      S.consoleHeight = currentH;
    }
    consoleEl.style.display = 'none';
    const btn = document.getElementById('btn-toggle-console');
    if (btn) btn.classList.remove('active');
  } else {
    consoleEl.style.display = 'flex';
    const targetH = S.consoleHeight || 220;
    consoleEl.style.height = targetH + 'px';
    const btn = document.getElementById('btn-toggle-console');
    if (btn) btn.classList.add('active');
    setTimeout(() => { if (editor) editor.refresh(); }, 50);
  }
}
