// ═══════════════════════════════════════════════════════════════════
// FILES WORKSPACE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════
// The explorer uses the File System Access API when it is available.  This
// keeps the actual files in a user-selected directory instead of in browser
// storage.  IndexedDB stores only the permissioned directory handle; browsers
// never expose the user's absolute path to page JavaScript.
let localWorkspaceHandle = null;
let workspaceWriteTimer = null;
const WORKSPACE_HANDLE_DB = 'codexa-workspace';
const WORKSPACE_HANDLE_STORE = 'handles';
const WORKSPACE_HANDLE_KEY = 'primary';
const WORKSPACE_MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);

function hasNativeWorkspaceSupport() {
  return !!(window.showDirectoryPicker && window.indexedDB);
}

function openWorkspaceHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WORKSPACE_HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open workspace storage'));
  });
}

async function getStoredWorkspaceHandle() {
  const db = await openWorkspaceHandleDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(WORKSPACE_HANDLE_STORE, 'readonly')
      .objectStore(WORKSPACE_HANDLE_STORE).get(WORKSPACE_HANDLE_KEY);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function storeWorkspaceHandle(handle) {
  const db = await openWorkspaceHandleDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(WORKSPACE_HANDLE_STORE, 'readwrite')
      .objectStore(WORKSPACE_HANDLE_STORE).put(handle, WORKSPACE_HANDLE_KEY);
    request.onsuccess = () => { db.close(); resolve(); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

function updateWorkspaceStatus(text, connected = false) {
  const status = document.getElementById('workspace-folder-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('connected', connected);
  status.title = text;
}

function persistBrowserWorkspace() {
  if (!localWorkspaceHandle) {
    localStorage.setItem('mongosandbox_files', JSON.stringify(S.files));
  }
}

function resetOpenWorkspaceTabs() {
  document.querySelectorAll('#tabbar .tab:not(.tab-add)').forEach(tab => tab.remove());
  S.tabs = [];
  S.activeFile = null;
  S.activeFolder = null;
}

function isTextWorkspaceFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return !ext || ['txt','log','csv','js','jsx','mjs','cjs','ts','tsx','py','java','c','h','cpp','cc','cxx','hpp','cs','go','rs','swift','kt','php','rb','dart','scala','lua','ex','exs','zig','html','htm','css','scss','sass','less','json','jsonc','json5','xml','yaml','yml','md','markdown','sh','bash','zsh','fish','ps1','sql','sqlite','sqlite3','db','db3','mongo','graphql','gql','vue','svelte','bat','toml','ini','env','asm'].includes(ext);
}

let workspacePreviewUrl = null;
let workspaceGeneratedPreviewUrls = [];
let workspacePreviewLayoutState = null;
let workspacePreviewTransform = { scale: 1, rotation: 0 };

function setWorkspacePreviewLayout(active) {
  const consoleEl = document.getElementById('console');
  const consoleResizer = document.getElementById('console-resizer');
  const inspector = document.getElementById('inspector');
  const consoleButton = document.getElementById('btn-toggle-console');
  const inspectorButton = document.getElementById('btn-toggle-inspector');
  if (active) {
    if (!workspacePreviewLayoutState) {
      workspacePreviewLayoutState = {
        consoleDisplay: consoleEl ? consoleEl.style.display : '',
        consoleHeight: consoleEl ? consoleEl.style.height : '',
        resizerDisplay: consoleResizer ? consoleResizer.style.display : '',
        inspectorDisplay: inspector ? inspector.style.display : '',
      };
    }
    if (consoleEl) consoleEl.style.display = 'none';
    if (consoleResizer) consoleResizer.style.display = 'none';
    if (inspector) inspector.style.display = 'none';
    if (consoleButton) consoleButton.classList.remove('active');
    if (inspectorButton) inspectorButton.classList.remove('active');
  } else if (workspacePreviewLayoutState) {
    const state = workspacePreviewLayoutState;
    if (consoleEl) { consoleEl.style.display = state.consoleDisplay; consoleEl.style.height = state.consoleHeight; }
    if (consoleResizer) consoleResizer.style.display = state.resizerDisplay;
    if (inspector) inspector.style.display = state.inspectorDisplay;
    if (consoleButton) consoleButton.classList.toggle('active', state.consoleDisplay !== 'none');
    if (inspectorButton) inspectorButton.classList.toggle('active', state.inspectorDisplay !== 'none');
    workspacePreviewLayoutState = null;
    setTimeout(() => { if (editor) editor.refresh(); }, 50);
  }
}

function getWorkspacePreviewKind(name) {
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  if (['png','jpg','jpeg','gif','webp','bmp','svg','avif','ico'].includes(ext)) return 'image';
  if (['mp4','webm','ogv','mov','m4v'].includes(ext)) return 'video';
  if (['mp3','wav','ogg','oga','m4a','aac','flac'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (['doc','docx','odt','ppt','pptx','xls','xlsx','csv'].includes(ext)) return 'document';
  return null;
}

function clearWorkspaceFilePreview() {
  if (workspacePreviewUrl) URL.revokeObjectURL(workspacePreviewUrl);
  workspacePreviewUrl = null;
  workspaceGeneratedPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  workspaceGeneratedPreviewUrls = [];
  const preview = document.getElementById('workspace-file-preview');
  const wrap = document.getElementById('cm-wrap');
  if (preview) {
    preview.classList.remove('active');
    preview.innerHTML = '';
  }
  if (wrap) wrap.classList.remove('preview-active');
  setWorkspacePreviewLayout(false);
}

function applyWorkspacePreviewTransform() {
  const content = document.querySelector('#workspace-file-preview .workspace-preview-content');
  if (!content) return;
  // `zoom` changes layout dimensions, so the stage scrollbars follow the
  // actual preview instead of zooming the surrounding editor shell.
  content.style.zoom = String(workspacePreviewTransform.scale);
  content.style.transform = `rotate(${workspacePreviewTransform.rotation}deg)`;
  content.style.transformOrigin = 'center center';
  const label = document.getElementById('workspace-preview-zoom');
  if (label) label.textContent = `${Math.round(workspacePreviewTransform.scale * 100)}%`;
}

function changeWorkspacePreviewZoom(delta) {
  workspacePreviewTransform.scale = Math.min(4, Math.max(0.25, workspacePreviewTransform.scale + delta));
  applyWorkspacePreviewTransform();
}

function rotateWorkspacePreview(delta) {
  workspacePreviewTransform.rotation = (workspacePreviewTransform.rotation + delta + 360) % 360;
  applyWorkspacePreviewTransform();
}

function resetWorkspacePreviewTransform() {
  workspacePreviewTransform = { scale: 1, rotation: 0 };
  applyWorkspacePreviewTransform();
}

function createWorkspacePreviewChrome(preview, file, kind) {
  const toolbar = document.createElement('div');
  toolbar.className = 'workspace-preview-toolbar';
  toolbar.dataset.previewKind = kind;
  const title = document.createElement('span');
  title.className = 'workspace-preview-title';
  title.textContent = file.name;
  toolbar.append(title);

  // Every supported preview gets the same compact viewer chrome. PDF still
  // renders through the browser's native PDF engine inside the stage, while
  // the shared controls keep the surrounding file experience consistent.
  if (kind) {
    const controls = document.createElement('div');
    controls.className = 'workspace-preview-controls';
    const addButton = (label, text, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.textContent = text;
      button.addEventListener('click', handler);
      controls.appendChild(button);
    };
    addButton('Zoom out', '−', () => changeWorkspacePreviewZoom(-0.1));
    const zoom = document.createElement('span');
    zoom.id = 'workspace-preview-zoom';
    zoom.className = 'workspace-preview-zoom';
    zoom.textContent = '100%';
    controls.appendChild(zoom);
    addButton('Zoom in', '+', () => changeWorkspacePreviewZoom(0.1));
    addButton('Rotate clockwise', '↻', () => rotateWorkspacePreview(90));
    addButton('Reset view', '⟳', resetWorkspacePreviewTransform);
    addButton('Download file', '⇩', () => {
      if (!workspacePreviewUrl) return;
      const link = document.createElement('a');
      link.href = workspacePreviewUrl;
      link.download = file.name;
      link.click();
    });
    addButton('Print preview', '⎙', () => {
      if (!workspacePreviewUrl) return;
      const printWindow = window.open(workspacePreviewUrl, '_blank', 'noopener');
      if (printWindow) printWindow.addEventListener('load', () => printWindow.print(), { once: true });
    });
    toolbar.appendChild(controls);
  }
  preview.appendChild(toolbar);
  const stage = document.createElement('div');
  stage.className = 'workspace-preview-stage';
  const content = document.createElement('div');
  content.className = 'workspace-preview-content';
  stage.appendChild(content);
  preview.appendChild(stage);
  workspacePreviewTransform = { scale: 1, rotation: 0 };
  applyWorkspacePreviewTransform();
  return content;
}

function normalizePptxTarget(target) {
  const parts = `ppt/slides/${String(target || '').replace(/^\//, '')}`.split('/');
  const normalized = [];
  parts.forEach(part => {
    if (!part || part === '.') return;
    if (part === '..') normalized.pop(); else normalized.push(part);
  });
  return normalized.join('/');
}

async function renderPptxPreview(source, content) {
  if (!window.JSZip) throw new Error('PPTX preview engine is not available. Check your network connection and reload.');
  const zip = await window.JSZip.loadAsync(await source.arrayBuffer());
  const slideNames = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  if (!slideNames.length) throw new Error('This presentation does not contain readable slides.');
  const parser = new DOMParser();
  let pageWidth = 13.333;
  let pageHeight = 7.5;
  if (zip.files['ppt/presentation.xml']) {
    const presentationXml = parser.parseFromString(await zip.files['ppt/presentation.xml'].async('text'), 'application/xml');
    const size = presentationXml.getElementsByTagName('p:sldSz')[0];
    if (size) {
      pageWidth = Math.max(1, Number(size.getAttribute('cx')) / 914400 || pageWidth);
      pageHeight = Math.max(1, Number(size.getAttribute('cy')) / 914400 || pageHeight);
    }
  }
  content.classList.add('workspace-pptx-content');
  const pageLabel = document.querySelector('.workspace-preview-page');
  if (pageLabel) pageLabel.textContent = `1 / ${slideNames.length}`;
  for (let index = 0; index < slideNames.length; index++) {
    const slideName = slideNames[index];
    const xml = parser.parseFromString(await zip.files[slideName].async('text'), 'application/xml');
    const slide = document.createElement('section');
    slide.className = 'workspace-pptx-slide';
    const label = document.createElement('div');
    label.className = 'workspace-pptx-slide-number';
    label.textContent = `Slide ${index + 1}`;
    slide.appendChild(label);
    slide.style.aspectRatio = `${pageWidth} / ${pageHeight}`;
    const shapeFrame = node => {
      const transform = node.getElementsByTagName('a:xfrm')[0];
      const offset = transform?.getElementsByTagName('a:off')[0];
      const extent = transform?.getElementsByTagName('a:ext')[0];
      if (!offset || !extent) return null;
      return {
        left: (Number(offset.getAttribute('x')) / 914400 / pageWidth) * 100,
        top: (Number(offset.getAttribute('y')) / 914400 / pageHeight) * 100,
        width: (Number(extent.getAttribute('cx')) / 914400 / pageWidth) * 100,
        height: (Number(extent.getAttribute('cy')) / 914400 / pageHeight) * 100,
      };
    };
    const positionShape = (element, frame) => {
      if (!frame) return;
      element.style.left = `${frame.left}%`;
      element.style.top = `${frame.top}%`;
      element.style.width = `${frame.width}%`;
      element.style.height = `${frame.height}%`;
    };
    [...xml.getElementsByTagName('p:sp')].forEach(shape => {
      const textNodes = [...shape.getElementsByTagName('a:t')].map(node => node.textContent).filter(Boolean);
      if (!textNodes.length) return;
      const text = document.createElement('div');
      text.className = 'workspace-pptx-text';
      text.textContent = textNodes.join('');
      const runSize = shape.getElementsByTagName('a:rPr')[0]?.getAttribute('sz');
      if (runSize) text.style.fontSize = `${Math.max(8, Number(runSize) / 100)}pt`;
      positionShape(text, shapeFrame(shape));
      slide.appendChild(text);
    });
    const relName = `ppt/slides/_rels/${slideName.split('/').pop()}.rels`;
    const relationships = {};
    if (zip.files[relName]) {
      const relXml = parser.parseFromString(await zip.files[relName].async('text'), 'application/xml');
      [...relXml.getElementsByTagName('Relationship')].forEach(rel => {
        relationships[rel.getAttribute('Id')] = normalizePptxTarget(rel.getAttribute('Target'));
      });
    }
    for (const blip of [...xml.getElementsByTagName('a:blip')]) {
      const target = relationships[blip.getAttribute('r:embed')];
      if (!target || !zip.files[target]) continue;
      const bytes = await zip.files[target].async('uint8array');
      const ext = target.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
      const image = document.createElement('img');
      image.className = 'workspace-pptx-image';
      image.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
      workspaceGeneratedPreviewUrls.push(image.src);
      image.alt = `Slide ${index + 1} image`;
      positionShape(image, shapeFrame(blip.closest('p:pic') || blip));
      slide.appendChild(image);
    }
    if (!slide.querySelector('.workspace-pptx-text, .workspace-pptx-image')) {
      const empty = document.createElement('div');
      empty.className = 'workspace-pptx-empty';
      empty.textContent = 'Slide contains visual elements that this browser preview cannot reproduce.';
      slide.appendChild(empty);
    }
    content.appendChild(slide);
  }
}

function previewMessage(title, detail) {
  const preview = document.getElementById('workspace-file-preview');
  if (!preview) return;
  preview.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'workspace-preview-card';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const text = document.createElement('span');
  text.textContent = detail;
  card.append(heading, text);
  preview.appendChild(card);
}

async function getWorkspaceFileObject(path) {
  if (!localWorkspaceHandle) return null;
  const { parent, name } = workspaceParentPath(path);
  const directory = await getDirectoryAtPath(localWorkspaceHandle, parent, false);
  const handle = await directory.getFileHandle(name, { create: false });
  return handle.getFile();
}

async function showWorkspaceFilePreview(file, kind) {
  const preview = document.getElementById('workspace-file-preview');
  const wrap = document.getElementById('cm-wrap');
  if (!preview || !wrap) return;
  clearWorkspaceFilePreview();
  preview.classList.add('active');
  wrap.classList.add('preview-active');
  setWorkspacePreviewLayout(true);
  const content = createWorkspacePreviewChrome(preview, file, kind);
  try {
    const source = await getWorkspaceFileObject(file.path);
    if (!source) {
      const card = document.createElement('div'); card.className = 'workspace-preview-card';
      card.textContent = 'Connect a local folder to preview this file.'; content.appendChild(card);
      return;
    }
    if (S.activeFile !== file.path) return;
    if (kind === 'pptx') {
      workspacePreviewUrl = URL.createObjectURL(source);
      await renderPptxPreview(source, content);
      applyWorkspacePreviewTransform();
      return;
    }
    workspacePreviewUrl = URL.createObjectURL(source);
    let element;
    if (kind === 'image') {
      element = document.createElement('img');
      element.alt = file.name;
    } else if (kind === 'video') {
      element = document.createElement('video');
      element.controls = true;
      element.autoplay = false;
    } else if (kind === 'audio') {
      element = document.createElement('audio');
      element.controls = true;
    } else if (kind === 'pdf') {
      element = document.createElement('iframe');
      element.title = file.name;
    }
    if (element) {
      element.className = `workspace-preview-${kind}`;
      element.src = workspacePreviewUrl;
      content.appendChild(element);
    } else {
      const card = document.createElement('div'); card.className = 'workspace-preview-card';
      const heading = document.createElement('strong'); heading.textContent = 'Document preview';
      const detail = document.createElement('span'); detail.textContent = `${file.name} is available from the selected folder but is not directly editable in the browser.`;
      card.append(heading, detail);
      const link = document.createElement('a');
      link.href = workspacePreviewUrl;
      link.download = file.name;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open or download file';
      link.className = 'workspace-preview-link';
      card.appendChild(link); content.appendChild(card);
    }
    applyWorkspacePreviewTransform();
  } catch (error) {
    const card = document.createElement('div'); card.className = 'workspace-preview-card';
    card.textContent = error.message || 'The browser could not read this file.'; content.appendChild(card);
  }
}

async function readWorkspaceDirectory(directoryHandle, prefix = '', result = []) {
  for await (const [name, entry] of directoryHandle.entries()) {
    if (entry.kind === 'directory') {
      if (WORKSPACE_SKIP_DIRECTORIES.has(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      result.push({ name, path, type: 'folder', content: '', expanded: true });
      await readWorkspaceDirectory(entry, path, result);
      continue;
    }
    const file = await entry.getFile();
    const path = prefix ? `${prefix}/${name}` : name;
    let content = '';
    if (file.size <= WORKSPACE_MAX_TEXT_FILE_BYTES && isTextWorkspaceFile(file)) {
      try { content = await file.text(); } catch (_) { content = ''; }
    }
    result.push({ name, path, type: 'file', content });
  }
  return result;
}

async function loadDirectoryWorkspace(handle) {
  const oldExpanded = new Map(S.files.filter(f => f.type === 'folder').map(f => [f.path, f.expanded]));
  const files = await readWorkspaceDirectory(handle);
  files.forEach(file => {
    if (file.type === 'folder' && oldExpanded.has(file.path)) file.expanded = oldExpanded.get(file.path);
  });
  localWorkspaceHandle = handle;
  S.files = files;
  const validPaths = new Set(files.filter(f => f.type === 'file').map(f => f.path));
  S.tabs = S.tabs.filter(path => validPaths.has(path));
  document.querySelectorAll('#tabbar .tab:not(.tab-add)').forEach(tab => {
    const path = tab.dataset.path || '';
    if (!validPaths.has(path)) tab.remove();
  });
  if (!validPaths.has(S.activeFile)) {
    S.activeFile = null;
    if (editor) editor.setValue('');
  } else if (editor) {
    const active = S.files.find(f => f.path === S.activeFile);
    if (active) editor.setValue(active.content);
  }
  updateWorkspaceStatus(`Local folder: ${handle.name}`, true);
  renderFileTree();
  updateActiveTabStyle();
}

async function getDirectoryAtPath(rootHandle, path, create = false) {
  let current = rootHandle;
  for (const part of String(path || '').split('/').filter(Boolean)) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

function workspaceParentPath(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return { parent: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}

async function writeWorkspaceFile(path, content) {
  if (!localWorkspaceHandle) return;
  const { parent, name } = workspaceParentPath(path);
  const directory = await getDirectoryAtPath(localWorkspaceHandle, parent, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function createWorkspaceDirectory(path) {
  if (!localWorkspaceHandle) return;
  const { parent, name } = workspaceParentPath(path);
  const directory = await getDirectoryAtPath(localWorkspaceHandle, parent, true);
  await directory.getDirectoryHandle(name, { create: true });
}

async function removeWorkspaceEntry(path, type) {
  if (!localWorkspaceHandle) return;
  const { parent, name } = workspaceParentPath(path);
  const directory = await getDirectoryAtPath(localWorkspaceHandle, parent, false);
  await directory.removeEntry(name, { recursive: type === 'folder' });
}

async function copyDirectoryContents(source, target) {
  for await (const [name, entry] of source.entries()) {
    if (entry.kind === 'directory') {
      const child = await target.getDirectoryHandle(name, { create: true });
      await copyDirectoryContents(entry, child);
    } else {
      const sourceFile = await entry.getFile();
      const child = await target.getFileHandle(name, { create: true });
      const writable = await child.createWritable();
      await writable.write(await sourceFile.arrayBuffer());
      await writable.close();
    }
  }
}

async function renameWorkspaceEntry(oldPath, newPath, type) {
  if (!localWorkspaceHandle) return;
  const oldEntry = workspaceParentPath(oldPath);
  const newEntry = workspaceParentPath(newPath);
  const oldParent = await getDirectoryAtPath(localWorkspaceHandle, oldEntry.parent, false);
  const newParent = await getDirectoryAtPath(localWorkspaceHandle, newEntry.parent, true);
  if (type === 'folder') {
    const source = await oldParent.getDirectoryHandle(oldEntry.name);
    const target = await newParent.getDirectoryHandle(newEntry.name, { create: true });
    await copyDirectoryContents(source, target);
  } else {
    const source = await oldParent.getFileHandle(oldEntry.name);
    const sourceFile = await source.getFile();
    const target = await newParent.getFileHandle(newEntry.name, { create: true });
    const writable = await target.createWritable();
    await writable.write(await sourceFile.arrayBuffer());
    await writable.close();
  }
  await oldParent.removeEntry(oldEntry.name, { recursive: type === 'folder' });
}

function scheduleWorkspaceFileWrite(file) {
  if (!localWorkspaceHandle || !file || file.type !== 'file') return;
  clearTimeout(workspaceWriteTimer);
  workspaceWriteTimer = setTimeout(async () => {
    try {
      await writeWorkspaceFile(file.path, file.content);
    } catch (error) {
      console.error('workspace write error:', error);
      logOutput(`[error] Could not save ${file.name}: ${error.message}`);
    }
  }, 250);
}

async function chooseWorkspaceFolder(event) {
  if (event) event.stopPropagation();
  if (!window.showDirectoryPicker) {
    alert('Local folders are not supported in this browser. Use the latest Chrome or Edge over HTTPS.');
    return;
  }
  try {
    const previousFiles = localWorkspaceHandle ? [] : S.files.filter(Boolean).map(file => ({ ...file }));
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('Write permission was not granted for this folder.');
    await storeWorkspaceHandle(handle);
    await loadDirectoryWorkspace(handle);
    if (previousFiles.length && confirm(`Import the current browser workspace into “${handle.name}”?`)) {
      for (const file of previousFiles) {
        if (file.type === 'folder') await createWorkspaceDirectory(file.path);
        else await writeWorkspaceFile(file.path, file.content || '');
      }
      await loadDirectoryWorkspace(handle);
    }
  } catch (error) {
    if (error && error.name !== 'AbortError') {
      console.error('chooseWorkspaceFolder error:', error);
      alert(`Could not open the local folder: ${error.message}`);
    }
  }
}

async function loadFiles() {
  try {
    if (hasNativeWorkspaceSupport()) {
      const storedHandle = await getStoredWorkspaceHandle().catch(() => null);
      if (storedHandle) {
        const permission = await storedHandle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
        if (permission === 'granted') {
          await loadDirectoryWorkspace(storedHandle);
          return;
        }
      }
      updateWorkspaceStatus('Browser workspace · choose a local folder', false);
    } else {
      updateWorkspaceStatus('Browser workspace · local folder access unavailable', false);
    }

    // Safe fallback for browsers without File System Access API support.
    let localFiles = JSON.parse(localStorage.getItem('mongosandbox_files') || '[]');
    
    // Filter out legacy files
    const legacyPaths = ['01_find_paid.mongo', '02_aggregate_pipeline.mongo', 'kishor.mongo'];
    localFiles = localFiles.filter(lf => !legacyPaths.includes(lf.path));

    // Keep the workspace empty until the user explicitly creates a file.
    
    S.files = localFiles;
    persistBrowserWorkspace();
    
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

const EMBEDDED_ICONS = window.CODEXA_EMBEDDED_ICONS || {};
function embeddedIconMarkup(iconPath, alt, title) {
  const svg = EMBEDDED_ICONS[iconPath];
  if (svg) {
    return `<span class="file-type-icon inline-svg-icon" role="img" aria-label="${alt || 'File'}" title="${title || alt || ''}">${svg}</span>`;
  }
  return `<span class="file-type-icon inline-svg-icon" role="img" aria-label="${alt || 'File'}" title="${title || alt || ''}"></span>`;
}
const SVG_MONGO_LEAF = embeddedIconMarkup('icons/material/database.svg', 'MongoDB', 'MongoDB');
const SVG_FOLDER_ICON = embeddedIconMarkup('icons/material/folder-base.svg', 'Folder', 'Folder');
const SVG_FILE_ICON = embeddedIconMarkup('icons/material/document.svg', 'File', 'File');
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
  return embeddedIconMarkup(`icons/material/${icon}.svg`, `${icon} file`, icon);
}

function toggleFolder(path) {
  const folder = S.files.find(f => f.type === 'folder' && f.path === path);
  if (!folder) return;
  S.activeFolder = path;
  S.activeFile = null;
  folder.expanded = folder.expanded === false;
  persistBrowserWorkspace();
  renderFileTree();
}

function selectWorkspaceRoot(event) {
  // VS Code-style explorer behavior: clicking unused list space selects the
  // workspace root, while clicks on an item continue to use that item's
  // normal handler.
  if (event && event.target && event.target.closest('.file-item, button, input')) return;
  S.activeFolder = null;
  S.activeFile = null;
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
    container.innerHTML = `<div class="workspace-empty-state"><span>No files in this workspace.</span><button type="button" onclick="chooseWorkspaceFolder(event)">${localWorkspaceHandle ? 'Change folder' : 'Choose local folder'}</button></div>`;
    return;
  }
  
  // Sort: folders first, then files
  const sorted = [...S.files].sort((a,b) => a.path.localeCompare(b.path, undefined, {numeric:true}));
  
  container.innerHTML = sorted.map(f => {
    let icon = f.type === 'folder'
      ? embeddedIconMarkup(`icons/material/${f.expanded === false ? 'folder-base.svg' : 'folder-base-open.svg'}`, 'Folder', 'Folder')
      : fileIcon(f.name);
    if (f.type === 'file' && f.name.toLowerCase().endsWith('.mongo')) icon = SVG_MONGO_LEAF;
    const depth = f.path.split('/').length - 1;
    if (!isFileVisible(f.path)) return '';
    const indentClass = `style="padding-left:${28 + depth * 18}px"`;
    const isFolder = f.type === 'folder';
    const isActive = f.path === (S.activeFile || S.activeFolder);
    const folderArrow = isFolder
      ? `<span class="folder-chevron ${f.expanded === false ? '' : 'expanded'}" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M6 3.5 10.5 8 6 12.5"/></svg></span>`
      : '';
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
  
  const previewKind = getWorkspacePreviewKind(file.name);
  if (previewKind) {
    editor.setValue('');
    showWorkspaceFilePreview(file, previewKind);
  } else {
    clearWorkspaceFilePreview();
    editor.setValue(file.content);
  }
  
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

  if (typeof setSqlNotebookMode === 'function') {
    setSqlNotebookMode(lang === 'sql');
    if (lang === 'sql' && typeof initializeSqlNotebook === 'function') initializeSqlNotebook(file.content);
  }

  if (editor) {
    editor.setOption('mode', cmMode);
    setTimeout(() => editor.refresh(), 50);
  }

  // A file preview gets the full editor viewport; restore normal console and
  // inspector behavior when the user returns to a text/code file.
  if (previewKind) setWorkspacePreviewLayout(true);

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
  tab.dataset.path = file.path;
  tab.title = file.path;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('tabindex', '0');
  tab.innerHTML = `
    <span class="tab-file-icon">${fileIcon(file.name)}</span>
    <span class="tab-label" title="${esc(file.name)}">${esc(file.name)}</span>
    <button class="tab-close" title="Close ${esc(file.name)}" aria-label="Close ${esc(file.name)}" onclick="closeTab('${file.path}', event)">×</button>
  `;
  tab.onclick = () => openFileInTab(file.path);
  tab.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFileInTab(file.path);
    }
  };
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
      if (typeof setSqlNotebookMode === 'function') setSqlNotebookMode(false);
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

async function saveQuery() {
  if (!S.activeFile) return;
  const content = editor.getValue();
  const file = S.files.find(f => f.path === S.activeFile);
  if (!file) return;
  if (getWorkspacePreviewKind(file.name)) {
    logOutput(`[error] ${file.name} is a preview-only file and cannot be edited as text.`);
    return;
  }
  
  file.content = content;
  
  persistBrowserWorkspace();
  if (localWorkspaceHandle) {
    try {
      await writeWorkspaceFile(file.path, file.content);
      logOutput(`[info] Saved ${file.name} to ${localWorkspaceHandle.name}`);
    } catch (error) {
      logOutput(`[error] Could not save ${file.name}: ${error.message}`);
      return;
    }
  } else {
    logOutput(`[info] Saved ${file.name} to browser workspace`);
  }
  const tabEl = document.getElementById(`tab-${escId(S.activeFile)}`);
  if (tabEl) tabEl.classList.remove('dirty');
}

// ═══════════════════════════════════════════════════════════════════
// CRUD FILE SYSTEM DIALOGS
// ═══════════════════════════════════════════════════════════════════
async function createNewQueryFile(event) {
  if (event) event.stopPropagation();
  if (hasNativeWorkspaceSupport() && !localWorkspaceHandle) {
    await chooseWorkspaceFolder();
    if (!localWorkspaceHandle) return;
  }
  renderInlineCreateInput('file');
}

async function createNewFolder(event) {
  if (event) event.stopPropagation();
  if (hasNativeWorkspaceSupport() && !localWorkspaceHandle) {
    await chooseWorkspaceFolder();
    if (!localWorkspaceHandle) return;
  }
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
  const handleFinish = async () => {
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
        try {
          await writeWorkspaceFile(fileObj.path, fileObj.content);
        } catch (error) {
          alert(`Could not create the file: ${error.message}`);
          renderFileTree();
          return;
        }
        S.files.push(fileObj);
        persistBrowserWorkspace();
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
        try {
          await createWorkspaceDirectory(folderObj.path);
        } catch (error) {
          alert(`Could not create the folder: ${error.message}`);
          renderFileTree();
          return;
        }
        S.files.push(folderObj);
        persistBrowserWorkspace();
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
  const handleRenameFinish = async () => {
    if (finished) return;
    finished = true;
    const newName = inputEl.value.trim();
    if (newName && newName !== currentName) {
      const oldPath = file.path;
      const parent = oldPath.split('/').slice(0, -1).join('/');
      const newPath = parent ? `${parent}/${newName}` : newName;
      if (S.files.some(item => item.path === newPath)) {
        alert('An item with that name already exists.');
        renderFileTree();
        return;
      }
      try {
        await renameWorkspaceEntry(oldPath, newPath, file.type);
      } catch (error) {
        alert(`Could not rename the item: ${error.message}`);
        renderFileTree();
        return;
      }
      const affected = S.files.filter(item => item.path === oldPath || item.path.startsWith(`${oldPath}/`));
      affected.forEach(item => {
        const suffix = item.path.slice(oldPath.length);
        item.path = `${newPath}${suffix}`;
        if (item.path === newPath) item.name = newName;
      });
      S.tabs = S.tabs.map(tabPath => tabPath === oldPath ? newPath : (tabPath.startsWith(`${oldPath}/`) ? `${newPath}${tabPath.slice(oldPath.length)}` : tabPath));
      if (S.activeFile === oldPath) S.activeFile = newPath;
      persistBrowserWorkspace();
      document.querySelectorAll('#tabbar .tab:not(.tab-add)').forEach(tab => tab.remove());
      S.tabs.forEach(tabPath => {
        const tabFile = S.files.find(item => item.path === tabPath);
        if (tabFile) createTabElement(tabFile);
      });
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
  const item = S.files.find(f => f.path === path);
  if (!item) return;
  (async () => {
    try {
      await removeWorkspaceEntry(path, item.type);
      S.tabs.filter(tabPath => tabPath === path || tabPath.startsWith(`${path}/`)).forEach(tabPath => closeTab(tabPath));
      S.files = S.files.filter(f => f.path !== path && !f.path.startsWith(`${path}/`));
      persistBrowserWorkspace();
      renderFileTree();
    } catch (error) {
      alert(`Could not delete the item: ${error.message}`);
    }
  })();
}
