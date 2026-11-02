// ═══════════════════════════════════════════════════════════════════
// VIEWS SWITCHING
// ═══════════════════════════════════════════════════════════════════
function showView(name) {
  // Browsing the workspace is public. Authentication is enforced at the
  // protected actions: execution, persistence, room creation/joining, and
  // exam submission.
  S.view = name;
  const ide = document.getElementById('ide-panel');
  const intro = document.getElementById('intro-panel');
  const titlebar = document.getElementById('titlebar');
  const statusbar = document.getElementById('statusbar');
  if (name === 'intro') {
    ide.style.display = 'none';
    intro.classList.add('active');
    // The welcome page is a focused landing screen; keep workspace panels
    // closed so the explorer never remains visible beside it.
    S.sidebarOpen = false;
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('resizer');
    if (sidebar) sidebar.style.display = 'none';
    if (resizer) resizer.style.display = 'none';
    if (titlebar) titlebar.style.display = 'none';
    if (statusbar) statusbar.style.display = 'none';
    
    // Set welcome icon active, others inactive
    const actWelcome = document.getElementById('act-welcome');
    if (actWelcome) actWelcome.classList.add('active');
    ['files', 'db', 'history', 'snippets', 'search'].forEach(p => {
      const actBtn = document.getElementById(`act-${p}`);
      if (actBtn) actBtn.classList.remove('active');
    });
  } else {
    intro.classList.remove('active');
    ide.style.display = 'flex';
    if (titlebar) titlebar.style.display = 'flex';
    if (statusbar) statusbar.style.display = 'flex';
    
    // Set current side panel button to active
    const actWelcome2 = document.getElementById('act-welcome');
    if (actWelcome2) actWelcome2.classList.remove('active');
    const actSide = document.getElementById(`act-${S.sidePanel}`);
    if (actSide) actSide.classList.add('active');

    if (typeof updateWorkspaceEmptyState === 'function') updateWorkspaceEmptyState();
    
    setTimeout(() => {
      if (editor) editor.refresh();
      if (S.activeFile && editor) editor.focus();
    }, 50);
  }
}
