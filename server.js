const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const W = 800, H = 500;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_HP = 5;

const WEAPONS = {
  pistol:   { speed: 8,  damage: 1, cooldown: 250, bullets: 1, spread: 0,    color: '#81d4fa' },
  shotgun:  { speed: 7,  damage: 1, cooldown: 600, bullets: 5, spread: 0.25, color: '#ffcc80' },
  sniper:   { speed: 18, damage: 3, cooldown: 900, bullets: 1, spread: 0,    color: '#ce93d8' }
};

const POWERUP_TYPES = ['speed', 'shield', 'rapidfire', 'weapon_shotgun', 'weapon_sniper'];

const OBSTACLES = [
  { x: 180, y: 160, w: 20, h: 120 },
  { x: 600, y: 160, w: 20, h: 120 },
  { x: 340, y: 60,  w: 120, h: 20 },
  { x: 340, y: 420, w: 120, h: 20 },
  { x: 260, y: 240, w: 80,  h: 20 },
  { x: 460, y: 240, w: 80,  h: 20 },
];

let gameState = {
  players: {},
  bullets: [],
  powerups: [],
  scores: { p1: 0, p2: 0 },
  phase: 'waiting',
  obstacles: OBSTACLES,
  killFeed: []
};

let lastBulletTime = {};
let powerupTimer = null;

function rectCircleCollide(rect, cx, cy, cr) {
  const nearX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nearX, dy = cy - nearY;
  return dx * dx + dy * dy < cr * cr;
}

function bulletHitsObstacle(b) {
  return OBSTACLES.some(o =>
    b.x >= o.x && b.x <= o.x + o.w && b.y >= o.y && b.y <= o.y + o.h
  );
}

function playerHitsObstacle(x, y) {
  return OBSTACLES.some(o => rectCircleCollide(o, x, y, PLAYER_RADIUS));
}

function addKillFeedEntry(killer, victim, weapon) {
  const entry = { killer, victim, weapon, time: Date.now() };
  gameState.killFeed.unshift(entry);
  if (gameState.killFeed.length > 5) gameState.killFeed.pop();
}

function spawnPowerup() {
  if (gameState.phase !== 'playing') return;
  if (gameState.powerups.length >= 3) return;
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  let x, y, tries = 0;
  do {
    x = 80 + Math.random() * (W - 160);
    y = 80 + Math.random() * (H - 160);
    tries++;
  } while (playerHitsObstacle(x, y) && tries < 20);
  gameState.powerups.push({ id: Date.now(), type, x, y });
}

function resetPositions() {
  if (gameState.players['p1']) {
    Object.assign(gameState.players['p1'], {
      x: 120, y: H / 2, hp: MAX_HP,
      weapon: 'pistol', speed: 4,
      shield: false, rapidfire: false,
      effects: []
    });
  }
  if (gameState.players['p2']) {
    Object.assign(gameState.players['p2'], {
      x: W - 120, y: H / 2, hp: MAX_HP,
      weapon: 'pistol', speed: 4,
      shield: false, rapidfire: false,
      effects: []
    });
  }
  gameState.bullets = [];
  gameState.powerups = [];
  gameState.phase = 'playing';
  if (powerupTimer) clearInterval(powerupTimer);
  powerupTimer = setInterval(spawnPowerup, 5000);
  setTimeout(spawnPowerup, 1000);
}

io.on('connection', (socket) => {
  const existingIds = Object.keys(gameState.players);
  if (existingIds.length >= 2) { socket.emit('full'); return; }

  const playerId = existingIds.length === 0 ? 'p1' : 'p2';
  socket.playerId = playerId;

  gameState.players[playerId] = {
    id: playerId,
    x: playerId === 'p1' ? 120 : W - 120,
    y: H / 2,
    hp: MAX_HP,
    angle: playerId === 'p1' ? 0 : Math.PI,
    weapon: 'pistol',
    speed: 4,
    shield: false,
    rapidfire: false,
    effects: []
  };
  lastBulletTime[playerId] = 0;

  socket.emit('assignId', playerId);
  socket.emit('obstacles', OBSTACLES);
  io.emit('stateUpdate', gameState);

  if (Object.keys(gameState.players).length === 2) {
    resetPositions();
    io.emit('stateUpdate', gameState);
  }

  socket.on('input', (input) => {
    const p = gameState.players[playerId];
    if (!p || gameState.phase !== 'playing') return;

    const spd = p.speed || 4;
    let nx = p.x, ny = p.y;
    if (input.up)    ny -= spd;
    if (input.down)  ny += spd;
    if (input.left)  nx -= spd;
    if (input.right) nx += spd;

    nx = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, nx));
    ny = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, ny));

    if (!playerHitsObstacle(nx, ny)) { p.x = nx; p.y = ny; }
    else if (!playerHitsObstacle(nx, p.y)) { p.x = nx; }
    else if (!playerHitsObstacle(p.x, ny)) { p.y = ny; }

    const other = gameState.players[playerId === 'p1' ? 'p2' : 'p1'];
    if (other) p.angle = Math.atan2(other.y - p.y, other.x - p.x);

    const wep = WEAPONS[p.weapon] || WEAPONS.pistol;
    const cooldown = p.rapidfire ? wep.cooldown * 0.4 : wep.cooldown;
    const now = Date.now();

    if (input.shoot && now - (lastBulletTime[playerId] || 0) > cooldown) {
      lastBulletTime[playerId] = now;
      for (let i = 0; i < wep.bullets; i++) {
        const spread = (Math.random() - 0.5) * wep.spread;
        const ang = p.angle + spread;
        gameState.bullets.push({
          id: now + playerId + i,
          owner: playerId,
          weapon: p.weapon,
          damage: wep.damage,
          x: p.x + Math.cos(ang) * (PLAYER_RADIUS + 6),
          y: p.y + Math.sin(ang) * (PLAYER_RADIUS + 6),
          vx: Math.cos(ang) * wep.speed,
          vy: Math.sin(ang) * wep.speed,
          color: wep.color
        });
      }
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[playerId];
    delete lastBulletTime[playerId];
    gameState.bullets = [];
    gameState.powerups = [];
    gameState.phase = 'waiting';
    if (powerupTimer) { clearInterval(powerupTimer); powerupTimer = null; }
    io.emit('stateUpdate', gameState);
  });
});

function gameTick() {
  if (gameState.phase !== 'playing') return;

  const now = Date.now();

  gameState.bullets = gameState.bullets.filter(b => {
    b.x += b.vx; b.y += b.vy;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) return false;
    if (bulletHitsObstacle(b)) {
      io.emit('hitEffect', { x: b.x, y: b.y, type: 'wall' });
      return false;
    }
    for (const [pid, p] of Object.entries(gameState.players)) {
      if (pid === b.owner) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + BULLET_RADIUS) {
        if (p.shield) {
          p.shield = false;
          io.emit('hitEffect', { x: p.x, y: p.y, type: 'shield' });
          return false;
        }
        p.hp -= b.damage;
        io.emit('hitEffect', { x: p.x, y: p.y, type: 'hit' });
        if (p.hp <= 0) {
          const winner = b.owner;
          gameState.scores[winner]++;
          addKillFeedEntry(winner, pid, b.weapon);
          gameState.phase = 'roundOver';
          io.emit('roundOver', { winner, loser: pid, scores: gameState.scores, killFeed: gameState.killFeed });
          setTimeout(() => { resetPositions(); io.emit('stateUpdate', gameState); }, 2500);
        }
        return false;
      }
    }
    return true;
  });

  gameState.powerups = gameState.powerups.filter(pu => {
    for (const [pid, p] of Object.entries(gameState.players)) {
      const dx = pu.x - p.x, dy = pu.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + 14) {
        if (pu.type === 'speed')           { p.speed = 7; setTimeout(() => { if(gameState.players[pid]) gameState.players[pid].speed = 4; }, 5000); }
        else if (pu.type === 'shield')     { p.shield = true; }
        else if (pu.type === 'rapidfire')  { p.rapidfire = true; setTimeout(() => { if(gameState.players[pid]) gameState.players[pid].rapidfire = false; }, 6000); }
        else if (pu.type === 'weapon_shotgun') { p.weapon = 'shotgun'; setTimeout(() => { if(gameState.players[pid]) gameState.players[pid].weapon = 'pistol'; }, 10000); }
        else if (pu.type === 'weapon_sniper')  { p.weapon = 'sniper';  setTimeout(() => { if(gameState.players[pid]) gameState.players[pid].weapon = 'pistol'; }, 10000); }
        io.emit('powerupCollected', { pid, type: pu.type, x: pu.x, y: pu.y });
        return false;
      }
    }
    return true;
  });

  io.emit('stateUpdate', gameState);
}

setInterval(gameTick, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game running at http://localhost:${PORT}`));
