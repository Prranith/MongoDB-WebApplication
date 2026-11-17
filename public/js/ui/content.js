// INTERNAL PUBLIC CONTENT VIEW
// Public information pages remain crawlable at their own URLs, but links from
// the CodeLeaf shell open the same content inside the editor workspace.
const WORKSPACE_CONTENT_ROUTES = new Set([
  '/about',
  '/faq',
  '/guides/sql-playground',
  '/guides/mongodb-playground',
  '/privacy',
  '/terms',
  '/contact',
]);
const WORKSPACE_SHELL_ROUTES = new Set(['/', '/workspace', '/workspaceide']);

const WORKSPACE_CONTENT_CACHE = new Map();
let workspaceContentRequest = null;
let workspaceContentPreviousFile = null;
let workspaceContentPreviousLanguage = null;

function workspaceContentPath(value) {
  try {
    return new URL(value, window.location.origin).pathname;
  } catch (_) {
    return '';
  }
}

function isWorkspaceContentRoute(value) {
  return WORKSPACE_CONTENT_ROUTES.has(workspaceContentPath(value));
}

function workspaceContentButton(label, text, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'workspace-content-toolbar-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = text;
  button.addEventListener('click', handler);
  return button;
}

function renderWorkspaceContentLoading(path) {
  const view = document.getElementById('workspace-content-view');
  if (!view) return;
  view.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'workspace-content-loading';
  loading.innerHTML = '<span class="workspace-content-loader" aria-hidden="true"></span>';
  const message = document.createElement('span');
  message.textContent = `Opening ${path.replace(/^\//, '')}…`;
  loading.appendChild(message);
  view.appendChild(loading);
}

function renderWorkspaceContentError(message) {
  const view = document.getElementById('workspace-content-view');
  if (!view) return;
  view.replaceChildren();
  const error = document.createElement('div');
  error.className = 'workspace-content-error';
  const title = document.createElement('strong');
  title.textContent = 'Unable to open this page';
  const detail = document.createElement('span');
  detail.textContent = message || 'Please try again.';
  const retry = workspaceContentButton('Retry', 'Retry', () => openWorkspaceContent(view.dataset.route));
  error.append(title, detail, retry);
  view.appendChild(error);
}

function buildWorkspaceContentView(route, pageHtml) {
  const view = document.getElementById('workspace-content-view');
  if (!view) return;
  const parsed = new DOMParser().parseFromString(pageHtml, 'text/html');
  const source = parsed.querySelector('main') || parsed.body;
  const documentBody = source.cloneNode(true);
  documentBody.classList.add('workspace-content-document');
  documentBody.querySelectorAll('script, style, link, form').forEach(node => node.remove());

  const shell = document.createElement('div');
  shell.className = 'workspace-content-shell';

  const toolbar = document.createElement('div');
  toolbar.className = 'workspace-content-toolbar';
  const breadcrumb = document.createElement('span');
  breadcrumb.className = 'workspace-content-breadcrumb';
  breadcrumb.textContent = 'CODELEAF  /  GUIDES & INFORMATION';
  const title = document.createElement('span');
  title.className = 'workspace-content-toolbar-title';
  title.textContent = parsed.title.replace(/\s*\|.*$/, '').trim() || 'CodeLeaf information';
  const close = workspaceContentButton('Return to editor', '×', () => closeWorkspaceContent());
  close.classList.add('workspace-content-close');
  toolbar.append(breadcrumb, title, close);

  const scroll = document.createElement('div');
  scroll.className = 'workspace-content-scroll';
  scroll.appendChild(documentBody);
  shell.append(toolbar, scroll);
  view.replaceChildren(shell);
  view.dataset.route = route;

  documentBody.querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (isWorkspaceContentRoute(href)) link.dataset.workspaceContentRoute = workspaceContentPath(href);
  });
}

async function openWorkspaceContent(route) {
  const path = workspaceContentPath(route);
  if (!WORKSPACE_CONTENT_ROUTES.has(path)) return false;
  const view = document.getElementById('workspace-content-view');
  const ide = document.getElementById('ide-panel');
  if (!view || !ide) return false;

  if (workspaceContentPreviousFile === null) workspaceContentPreviousFile = S.activeFile || '';
  if (workspaceContentPreviousLanguage === null) {
    const indicator = document.getElementById('sb-lang-indicator');
    workspaceContentPreviousLanguage = indicator ? indicator.textContent : '';
  }
  if (workspaceContentRequest) workspaceContentRequest.abort();
  const request = new AbortController();
  workspaceContentRequest = request;

  showView('ide');
  if (S.sidePanel !== 'resources') setSidePanel('resources');
  ide.classList.add('workspace-content-active');
  document.body.classList.add('workspace-content-active');
  view.hidden = false;
  view.classList.add('active');
  view.dataset.route = path;
  const indicator = document.getElementById('sb-lang-indicator');
  if (indicator) indicator.textContent = 'Guide';
  renderWorkspaceContentLoading(path);

  try {
    let html = WORKSPACE_CONTENT_CACHE.get(path);
    if (!html) {
      const response = await fetch(path, { signal: request.signal, headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error(`The page returned HTTP ${response.status}.`);
      html = await response.text();
      WORKSPACE_CONTENT_CACHE.set(path, html);
    }
    if (workspaceContentRequest !== request || !view.classList.contains('active') || view.dataset.route !== path) return true;
    buildWorkspaceContentView(path, html);
  } catch (error) {
    if (error && error.name === 'AbortError') return true;
    renderWorkspaceContentError(error && error.message);
  } finally {
    if (workspaceContentRequest === request) workspaceContentRequest = null;
  }
  return true;
}

function closeWorkspaceContent(options = {}) {
  if (workspaceContentRequest) workspaceContentRequest.abort();
  workspaceContentRequest = null;
  const view = document.getElementById('workspace-content-view');
  const ide = document.getElementById('ide-panel');
  if (view) {
    view.hidden = true;
    view.classList.remove('active');
    view.replaceChildren();
    delete view.dataset.route;
  }
  if (ide) ide.classList.remove('workspace-content-active');
  document.body.classList.remove('workspace-content-active');
  const indicator = document.getElementById('sb-lang-indicator');
  if (indicator && workspaceContentPreviousLanguage !== null) indicator.textContent = workspaceContentPreviousLanguage;
  const previousFile = workspaceContentPreviousFile;
  workspaceContentPreviousFile = null;
  workspaceContentPreviousLanguage = null;
  if (options.restore !== false && previousFile && typeof openFileInTab === 'function') {
    openFileInTab(previousFile);
  } else if (typeof updateWorkspaceEmptyState === 'function') {
    updateWorkspaceEmptyState();
  }
}

function initWorkspaceContentLinks() {
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const resourceLink = link.closest('#panel-resources');
    const internalLink = link.dataset.workspaceContentRoute;
    const path = internalLink || (resourceLink ? workspaceContentPath(link.getAttribute('href')) : '');
    const contentDocumentLink = link.closest('.workspace-content-document');
    if (!WORKSPACE_CONTENT_ROUTES.has(path) && !(contentDocumentLink && WORKSPACE_SHELL_ROUTES.has(path))) return;
    event.preventDefault();
    event.stopPropagation();
    if (contentDocumentLink && WORKSPACE_SHELL_ROUTES.has(path)) {
      closeWorkspaceContent({ restore: false });
      if (path === '/') showView('intro');
      else {
        showView('ide');
        setSidePanel('files');
      }
      return;
    }
    openWorkspaceContent(path);
  });
}

window.addEventListener('DOMContentLoaded', initWorkspaceContentLinks, { once: true });
