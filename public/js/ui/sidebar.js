// ═══════════════════════════════════════════════════════════════════
// DATABASE TREE RENDERER
// ═══════════════════════════════════════════════════════════════════
const SVG_COLLECTION_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" style="margin-right:6px;flex-shrink:0" fill="#a7a7a7"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm2 1v2h8V4H4zm0 3v2h8V7H4zm0 3v2h8v-2H4z"/></svg>`;

function renderDbTree() {
  const container = document.getElementById('coll-list');
  container.innerHTML = S.collections.map(c => `
    <div class="tree-item ${c.name === S.activeCollection ? 'active' : ''}" 
         onclick="setActiveCollection('${c.name}')"
         style="display: flex; align-items: center; justify-content: space-between; padding-right: 8px;">
      <div style="display: flex; align-items: center; min-width: 0; flex: 1;">
        ${SVG_COLLECTION_ICON}
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.name}</span>
        ${c.isCustom ? '<span class="custom-badge">custom</span>' : ''}
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="tree-badge">${c.count}</span>
        ${c.isCustom ? `<span class="delete-custom-btn" title="Delete dataset" onclick="deleteCustomCollection(event, '${c.name}')" style="font-weight: bold; cursor: pointer; color: var(--text3); font-size: 13px; padding: 2px;">×</span>` : ''}
      </div>
    </div>
  `).join('');
  container.style.display = S.dbRootOpen ? 'block' : 'none';
}

function deleteCustomCollection(event, name) {
  event.stopPropagation();
  if (!confirm(`Are you sure you want to delete the custom dataset "${name}"?`)) {
    return;
  }
  const customCollsMap = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
  delete customCollsMap[name];
  localStorage.setItem('mongosandbox_custom_collections', JSON.stringify(customCollsMap));
  
  if (S.activeCollection === name) {
    S.activeCollection = null;
  }
  loadCollections();
}

function uploadCustomDataset(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const rawData = JSON.parse(e.target.result);
      let docs = [];
      if (Array.isArray(rawData)) {
        docs = rawData;
      } else if (rawData && typeof rawData === 'object') {
        docs = [rawData];
      } else {
        throw new Error("Dataset JSON must be a list of objects or a single object.");
      }
      
      let defaultName = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
      let collName = prompt("Enter a name for this custom collection:", defaultName);
      if (!collName) return;
      collName = collName.trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(collName)) {
        alert("Invalid collection name. Use alphanumeric characters and underscores only, starting with a letter or underscore.");
        return;
      }
      
      const defaults = ['elite', 'users', 'orders', 'inventory', 'shipments', 'transactions'];
      if (defaults.includes(collName)) {
        alert(`Collection name "${collName}" is reserved for default datasets. Please use another name.`);
        return;
      }
      
      const customCollsMap = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
      customCollsMap[collName] = docs;
      localStorage.setItem('mongosandbox_custom_collections', JSON.stringify(customCollsMap));
      
      loadCollections();
      setActiveCollection(collName);
      
      event.target.value = '';
      alert(`Collection "${collName}" (${docs.length} documents) successfully loaded into local in-memory sandbox!`);
    } catch(err) {
      alert("Failed to parse JSON file: " + err.message);
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

function getCustomCollectionSchema(docs) {
  const schema = {};
  
  function getTypeName(val) {
    if (val === null) return "Null";
    if (typeof val === "boolean") return "Boolean";
    if (typeof val === "number") return Number.isInteger(val) ? "Int32" : "Double";
    if (typeof val === "string") return "String";
    if (val instanceof Date) return "Date";
    if (Array.isArray(val)) return "Array";
    if (typeof val === "object") {
      if (val.$oid) return "ObjectId";
      if (val.$date) return "Date";
      return "Object";
    }
    return typeof val;
  }

  function extract(obj, prefix) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.$oid || obj.$date) return;
    for (const [key, val] of Object.entries(obj)) {
      const fieldName = prefix ? `${prefix}.${key}` : key;
      const type = getTypeName(val);
      if (!schema[fieldName]) {
        schema[fieldName] = new Set();
      }
      schema[fieldName].add(type);
      if (val && typeof val === 'object' && !Array.isArray(val) && !val.$oid && !val.$date) {
        extract(val, fieldName);
      }
    }
  }

  docs.slice(0, 100).forEach(doc => extract(doc, ''));
  
  const result = {};
  for (const [field, typeSet] of Object.entries(schema)) {
    result[field] = Array.from(typeSet).sort();
  }
  return result;
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
  const collObj = S.collections.find(c => c.name === coll);
  if (collObj && collObj.isCustom) {
    const customCollsMap = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
    const docs = customCollsMap[coll] || [];
    const schema = getCustomCollectionSchema(docs);
    renderInspector(coll, schema, docs.length);
  } else {
    fetchAPI(`/api/schema/${coll}`).then(d => {
      renderInspector(coll, d.schema, d.count);
    });
  }
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
