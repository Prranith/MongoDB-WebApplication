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
