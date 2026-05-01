const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

let myId = null;
let state = { players: {}, bullets: [], powerups: [], scores: { p1: 0, p2: 0 }, phase: 'waiting', obstacles: [], killFeed: [] };
const keys = {};
let particles = [];
let screenShake = { x: 0, y: 0, dur: 0 };
let killFeedEntries = [];

const COLORS = {
  p1: { body: '#4fc3f7', dark: '#0277bd', bullet: '#81d4fa' },
  p2: { body: '#ef9a9a', dark: '#c62828', bullet: '#ffcdd2' }
};
const MAX_HP = 5;

const POWERUP_COLORS = {
  speed: '#69f0ae', shield: '#40c4ff', rapidfire: '#ff6e40',
  weapon_shotgun: '#ffca28', weapon_sniper: '#ce93d8'
};
const POWERUP_LABELS = {
  speed: 'SPD', shield: 'SHD', rapidfire: 'RFR',
  weapon_shotgun: 'SHG', weapon_sniper: 'SNP'
};

// ── Mobile joystick state ──────────────────────────────────────
const joystick = { active: false, startX: 0, startY: 0, dx: 0, dy: 0, id: null };
let mobileShoot = false;
const isMobile = 'ontouchstart' in window;

// ── Socket events ──────────────────────────────────────────────
socket.on('assignId', id => {
  myId = id;
  document.getElementById('status').textContent =
    id === 'p1' ? 'You are Player 1 (blue)' : 'You are Player 2 (red)';
});

socket.on('stateUpdate', s => {
  state = s;
  document.getElementById('p1score').textContent = `P1 ${s.scores.p1}`;
  document.getElementById('p2score').textContent = `P2 ${s.scores.p2}`;
  if (s.phase === 'waiting') document.getElementById('status').textContent = 'Waiting for second player...';
});

socket.on('obstacles', obs => { state.obstacles = obs; });

socket.on('hitEffect', ({ x, y, type }) => {
  if (type === 'hit') {
    spawnParticles(x, y, '#ff5252', 18);
    triggerShake(6, 200);
  } else if (type === 'shield') {
    spawnParticles(x, y, '#40c4ff', 12);
  } else if (type === 'wall') {
    spawnParticles(x, y, '#bbb', 6);
  }
});

socket.on('powerupCollected', ({ pid, type, x, y }) => {
  spawnParticles(x, y, POWERUP_COLORS[type] || '#fff', 14);
});

socket.on('roundOver', ({ winner, loser, scores, killFeed }) => {
  state.scores = scores;
  state.killFeed = killFeed || [];
  killFeedEntries = (killFeed || []).map(e => ({ ...e, alpha: 1 }));
  document.getElementById('p1score').textContent = `P1 ${scores.p1}`;
  document.getElementById('p2score').textContent = `P2 ${scores.p2}`;
  const msg = document.getElementById('message');
  msg.textContent = winner === myId ? 'YOU WIN!' : 'YOU LOSE';
  msg.style.color = winner === myId ? '#69f0ae' : '#ff5252';
  msg.classList.add('show');
  triggerShake(12, 400);
  setTimeout(() => msg.classList.remove('show'), 2200);
});

socket.on('full', () => {
  document.getElementById('status').textContent = 'Game full — spectating';
});

// ── Particles ──────────────────────────────────────────────────
function spawnParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 1.5 + Math.random() * 4;
    particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: 1, decay: 0.03 + Math.random() * 0.04,
      r: 2 + Math.random() * 3, color
    });
  }
}

function triggerShake(mag, dur) {
  screenShake.mag = mag;
  screenShake.dur = dur;
  screenShake.start = Date.now();
}

// ── Draw helpers ───────────────────────────────────────────────
function drawArena() {
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 50) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 50) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = '#ffffff08';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();
  ctx.setLineDash([]);
}

function drawObstacles() {
  for (const o of (state.obstacles || [])) {
    ctx.fillStyle = '#1e2a3a';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = '#4a6080';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = '#ffffff08';
    ctx.fillRect(o.x, o.y, o.w, 4);
  }
}

function drawPowerups() {
  const now = Date.now();
  for (const pu of (state.powerups || [])) {
    const pulse = 0.85 + 0.15 * Math.sin(now / 300);
    const col = POWERUP_COLORS[pu.type] || '#fff';
    ctx.save();
    ctx.translate(pu.x, pu.y);
    ctx.scale(pulse, pulse);
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = col + '33';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = 'bold 9px Courier New';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(POWERUP_LABELS[pu.type] || '?', 0, 0);
    ctx.restore();
  }
}

function drawPlayer(p) {
  const c = COLORS[p.id];
  const r = 18;
  ctx.save();
  ctx.translate(p.x, p.y);

  if (p.shield) {
    ctx.beginPath();
    ctx.arc(0, 0, r + 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#40c4ff88';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  if (p.rapidfire || p.speed > 4) {
    ctx.beginPath();
    ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
    ctx.fillStyle = (p.rapidfire ? '#ff6e40' : '#69f0ae') + '22';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = c.dark;
  ctx.fill();
  ctx.strokeStyle = c.body;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.rotate(p.angle);
  const wepColors = { pistol: c.body, shotgun: '#ffca28', sniper: '#ce93d8' };
  ctx.fillStyle = wepColors[p.weapon] || c.body;
  const gunLen = p.weapon === 'sniper' ? 22 : p.weapon === 'shotgun' ? 12 : 14;
  const gunH = p.weapon === 'shotgun' ? 10 : 7;
  ctx.fillRect(r - 2, -gunH/2, gunLen, gunH);
  ctx.restore();

  for (let i = 0; i < MAX_HP; i++) {
    const bx = p.x - (MAX_HP * 10) / 2 + i * 10 + 4;
    const by = p.y - r - 12;
    ctx.beginPath();
    ctx.arc(bx, by, 4, 0, Math.PI * 2);
    ctx.fillStyle = i < p.hp ? c.body : '#333';
    ctx.fill();
  }

  ctx.fillStyle = c.body + 'cc';
  ctx.font = 'bold 10px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText(p.id.toUpperCase() + (p.weapon !== 'pistol' ? ` [${p.weapon.toUpperCase().slice(0,3)}]` : ''), p.x, p.y + r + 16);
}

function drawBullet(b) {
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.weapon === 'sniper' ? 4 : b.weapon === 'shotgun' ? 3 : 5, 0, Math.PI * 2);
  ctx.fillStyle = b.color || '#fff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = (b.color || '#fff') + '33';
  ctx.fill();
}

function drawParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.92; p.vy *= 0.92;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
    ctx.fillStyle = p.color + Math.floor(p.life * 255).toString(16).padStart(2,'0');
    ctx.fill();
  }
}

function drawKillFeed() {
  const entries = state.killFeed || [];
  if (!entries.length) return;
  ctx.save();
  entries.slice(0, 4).forEach((e, i) => {
    const y = 16 + i * 22;
    const text = `${e.killer.toUpperCase()} killed ${e.victim.toUpperCase()} [${(e.weapon||'pistol').toUpperCase()}]`;
    ctx.font = '11px Courier New';
    ctx.fillStyle = `rgba(255,255,255,${0.7 - i * 0.15})`;
    ctx.textAlign = 'right';
    ctx.fillText(text, W - 10, y);
  });
  ctx.restore();
}

function drawWaiting() {
  ctx.fillStyle = '#ffffff22';
  ctx.font = 'bold 28px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('WAITING FOR PLAYERS', W/2, H/2 - 10);
  ctx.font = '14px Courier New';
  ctx.fillStyle = '#ffffff44';
  ctx.fillText('Open this page in two browser tabs or devices', W/2, H/2 + 30);
}

// ── Mobile controls ────────────────────────────────────────────
function setupMobileControls() {
  const ui = document.getElementById('mobile-ui');
  if (!isMobile) return;
  ui.style.display = 'flex';

  const stick = document.getElementById('joystick-base');
  const knob  = document.getElementById('joystick-knob');
  const shootBtn = document.getElementById('shoot-btn');

  stick.addEventListener('touchstart', e => {
    const t = e.touches[0];
    const r = stick.getBoundingClientRect();
    joystick.active = true;
    joystick.startX = r.left + r.width / 2;
    joystick.startY = r.top + r.height / 2;
    joystick.id = t.identifier;
    e.preventDefault();
  }, { passive: false });

  stick.addEventListener('touchmove', e => {
    for (const t of e.touches) {
      if (t.identifier !== joystick.id) continue;
      const dx = t.clientX - joystick.startX;
      const dy = t.clientY - joystick.startY;
      const dist = Math.min(Math.sqrt(dx*dx+dy*dy), 40);
      const ang = Math.atan2(dy, dx);
      joystick.dx = Math.cos(ang) * dist / 40;
      joystick.dy = Math.sin(ang) * dist / 40;
      knob.style.transform = `translate(${Math.cos(ang)*dist}px, ${Math.sin(ang)*dist}px)`;
    }
    e.preventDefault();
  }, { passive: false });

  stick.addEventListener('touchend', e => {
    joystick.active = false; joystick.dx = 0; joystick.dy = 0;
    knob.style.transform = 'translate(0,0)';
  });

  shootBtn.addEventListener('touchstart', e => { mobileShoot = true; e.preventDefault(); }, { passive: false });
  shootBtn.addEventListener('touchend',   e => { mobileShoot = false; });
}

// ── Input loop ─────────────────────────────────────────────────
function sendInput() {
  if (state.phase !== 'playing' || !myId) return;
  const isP1 = myId === 'p1';
  const DEAD = 0.2;

  if (isMobile) {
    socket.emit('input', {
      up:    joystick.dy < -DEAD,
      down:  joystick.dy >  DEAD,
      left:  joystick.dx < -DEAD,
      right: joystick.dx >  DEAD,
      shoot: mobileShoot
    });
  } else {
    socket.emit('input', {
      up:    isP1 ? keys['w'] : keys['ArrowUp'],
      down:  isP1 ? keys['s'] : keys['ArrowDown'],
      left:  isP1 ? keys['a'] : keys['ArrowLeft'],
      right: isP1 ? keys['d'] : keys['ArrowRight'],
      shoot: isP1 ? keys['f'] : keys['l']
    });
  }
}

document.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  keys[e.key] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});
document.addEventListener('keyup', e => {
  keys[e.key.toLowerCase()] = false;
  keys[e.key] = false;
});

// ── Main render loop ───────────────────────────────────────────
function render() {
  const now = Date.now();
  let sx = 0, sy = 0;
  if (screenShake.dur > 0) {
    const prog = (now - screenShake.start) / screenShake.dur;
    if (prog < 1) {
      const mag = screenShake.mag * (1 - prog);
      sx = (Math.random() - 0.5) * mag;
      sy = (Math.random() - 0.5) * mag;
    }
  }

  ctx.save();
  ctx.translate(sx, sy);

  drawArena();
  drawObstacles();
  drawPowerups();

  if (state.phase === 'waiting') drawWaiting();

  for (const p of Object.values(state.players)) drawPlayer(p);
  for (const b of state.bullets) drawBullet(b);

  drawParticles();
  drawKillFeed();

  ctx.restore();
  requestAnimationFrame(render);
}

setInterval(sendInput, 1000 / 60);
setupMobileControls();
render();
