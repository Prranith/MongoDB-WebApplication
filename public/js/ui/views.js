// ═══════════════════════════════════════════════════════════════════
// VIEWS SWITCHING
// ═══════════════════════════════════════════════════════════════════
function showView(name) {
  S.view = name;
  const ide = document.getElementById('ide-panel');
  const intro = document.getElementById('intro-panel');
  const titlebar = document.getElementById('titlebar');
  const toolbar = document.getElementById('toolbar');
  const statusbar = document.getElementById('statusbar');
  if (name === 'intro') {
    ide.style.display = 'none';
    intro.classList.add('active');
    if (titlebar) titlebar.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    if (statusbar) statusbar.style.display = 'none';
    
    // Set welcome icon active, others inactive
    document.getElementById('act-welcome')?.classList.add('active');
    ['files', 'db', 'history', 'snippets', 'search'].forEach(p => {
      document.getElementById(`act-${p}`)?.classList.remove('active');
    });
  } else {
    intro.classList.remove('active');
    ide.style.display = 'flex';
    if (titlebar) titlebar.style.display = 'flex';
    if (toolbar) toolbar.style.display = 'flex';
    if (statusbar) statusbar.style.display = 'flex';
    
    // Set current side panel button to active
    document.getElementById('act-welcome')?.classList.remove('active');
    document.getElementById(`act-${S.sidePanel}`)?.classList.add('active');
    
    setTimeout(() => {
      editor.refresh();
      editor.focus();
    }, 50);
  }
}
