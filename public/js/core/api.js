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
  heartbeatTimer = setInterval(sendHeartbeat, 30000);

  if (!window.hasHeartbeatListener) {
    window.hasHeartbeatListener = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat();
      }
    });
  }
}

async function sendHeartbeat() {
  if (document.visibilityState !== 'visible') {
    return;
  }
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
      ctx.fillStyle = 'rgba(0, 200, 80, 0.7)';
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
          const alpha = (1 - dist / connectionDistance) * 0.65;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 200, 80, ${alpha})`;
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
    const defaultColls = d.collections || [];
    
    // Load custom collections from local storage
    const customCollsMap = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
    const customColls = Object.entries(customCollsMap).map(([name, docs]) => ({
      name: name,
      count: Array.isArray(docs) ? docs.length : 0,
      isCustom: true
    }));
    
    S.collections = [...defaultColls, ...customColls];
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
