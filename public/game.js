const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

let myId = null;
let state = { players: {}, bullets: [], scores: { p1: 0, p2: 0 }, phase: 'waiting' };
const keys = {};

const COLORS = {
  p1: { body: '#4fc3f7', dark: '#0277bd', bullet: '#81d4fa' },
  p2: { body: '#ef9a9a', dark: '#c62828', bullet: '#ffcdd2' }
};
const MAX_HP = 5;

socket.on('assignId', (id) => {
  myId = id;
  document.getElementById('status').textContent =
    id === 'p1' ? 'You are Player 1 (blue) — waiting for P2...' : 'You are Player 2 (red) — game starting!';
});

socket.on('stateUpdate', (s) => {
  state = s;
  document.getElementById('p1score').textContent = `P1: ${s.scores.p1}`;
  document.getElementById('p2score').textContent = `P2: ${s.scores.p2}`;
  if (s.phase === 'playing') {
    document.getElementById('status').textContent =
      myId === 'p1' ? 'You are Player 1 (blue)' : 'You are Player 2 (red)';
  }
  if (s.phase === 'waiting') {
    document.getElementById('status').textContent = 'Waiting for second player...';
  }
});

socket.on('roundOver', ({ winner, scores }) => {
  const msg = document.getElementById('message');
  msg.textContent = winner === myId ? 'YOU WIN!' : 'YOU LOSE';
  msg.style.color = winner === myId ? '#69f0ae' : '#ff5252';
  msg.classList.add('show');
  setTimeout(() => msg.classList.remove('show'), 1800);
});

socket.on('full', () => {
  document.getElementById('status').textContent = 'Game full — open another tab to spectate';
});

function drawArena() {
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 50) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 50) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  ctx.strokeStyle = '#ffffff08';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  ctx.strokeStyle = '#ffffff06';
  ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);
}

function drawPlayer(p) {
  const c = COLORS[p.id];
  const r = 18;

  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = c.body + '22';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = c.dark;
  ctx.fill();
  ctx.strokeStyle = c.body;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.rotate(p.angle);
  ctx.fillStyle = c.body;
  ctx.fillRect(r - 2, -4, 14, 8);

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
  ctx.font = 'bold 11px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText(p.id.toUpperCase(), p.x, p.y + r + 16);
}

function drawBullet(b) {
  const c = COLORS[b.owner];
  ctx.beginPath();
  ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = c.bullet;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(b.x, b.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = c.bullet + '44';
  ctx.fill();
}

function render() {
  drawArena();

  if (state.phase === 'waiting') {
    ctx.fillStyle = '#ffffff22';
    ctx.font = 'bold 28px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('WAITING FOR PLAYERS', W / 2, H / 2 - 10);
    ctx.font = '14px Courier New';
    ctx.fillStyle = '#ffffff44';
    ctx.fillText('Open this page in two browser tabs', W / 2, H / 2 + 30);
  }

  for (const p of Object.values(state.players)) drawPlayer(p);
  for (const b of state.bullets) drawBullet(b);

  requestAnimationFrame(render);
}

function sendInput() {
  if (state.phase !== 'playing') return;
  const isP1 = myId === 'p1';
  socket.emit('input', {
    up:    isP1 ? keys['w'] : keys['ArrowUp'],
    down:  isP1 ? keys['s'] : keys['ArrowDown'],
    left:  isP1 ? keys['a'] : keys['ArrowLeft'],
    right: isP1 ? keys['d'] : keys['ArrowRight'],
    shoot: isP1 ? keys['f'] : keys['l']
  });
}

document.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  keys[e.key] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});
document.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  keys[e.key] = false;
});

setInterval(sendInput, 1000 / 60);
render();
