// ═══════════════════════════════════════════════════════════════════
// VIEWS SWITCHING
// ═══════════════════════════════════════════════════════════════════
function showView(name) {
  S.view = name;
  const ide = document.getElementById('ide-panel');
  const intro = document.getElementById('intro-panel');
  const titlebar = document.getElementById('titlebar');
  const statusbar = document.getElementById('statusbar');
  if (name === 'intro') {
    ide.style.display = 'none';
    intro.classList.add('active');
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
    
    setTimeout(() => {
      editor.refresh();
      editor.focus();
    }, 50);
  }
}
