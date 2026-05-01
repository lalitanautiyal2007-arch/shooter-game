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
const MAX_LIVES = 3;

const WEAPONS = {
  pistol:  { speed: 8,  damage: 1, cooldown: 250, bullets: 1, spread: 0,    color: '#81d4fa', ammo: Infinity },
  shotgun: { speed: 7,  damage: 1, cooldown: 600, bullets: 5, spread: 0.25, color: '#ffcc80', ammo: 12 },
  sniper:  { speed: 18, damage: 3, cooldown: 900, bullets: 1, spread: 0,    color: '#ce93d8', ammo: 6  },
  smg:     { speed: 9,  damage: 1, cooldown: 100, bullets: 1, spread: 0.08, color: '#a5d6a7', ammo: 30 },
  rocket:  { speed: 6,  damage: 4, cooldown: 1800,bullets: 1, spread: 0,    color: '#ff7043', ammo: 3, explosive: true  }
};

const POWERUP_TYPES = ['speed','shield','rapidfire','weapon_shotgun','weapon_sniper','weapon_smg','weapon_rocket','healthpack','invincible','tripleshot'];

const OBSTACLES = [
  { x: 180, y: 160, w: 20, h: 120 },
  { x: 600, y: 160, w: 20, h: 120 },
  { x: 340, y: 60,  w: 120, h: 20 },
  { x: 340, y: 420, w: 120, h: 20 },
  { x: 260, y: 240, w: 80,  h: 20 },
  { x: 460, y: 240, w: 80,  h: 20 },
  { x: 80,  y: 80,  w: 20,  h: 80  },
  { x: 680, y: 340, w: 20,  h: 80  },
  { x: 360, y: 200, w: 80,  h: 20  },
];

// Hazard zones that pulse damage
let hazardZones = [];
let hazardTimer = 0;

let gameState = {
  players: {}, bullets: [], grenades: [], explosions: [],
  powerups: [], scores: { p1: 0, p2: 0 },
  phase: 'waiting', obstacles: OBSTACLES, killFeed: [],
  hazardZones: [], roundNum: 1, matchStats: null, chatMessages: []
};

let lastBulletTime = {}, lastGrenadeTime = {}, lastDashTime = {};
let powerupTimer = null;

// Per-player ammo
let playerAmmo = {};

function rectCircleCollide(rect, cx, cy, cr) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < cr * cr;
}

function bulletHitsObstacle(b) {
  return OBSTACLES.some(o => b.x >= o.x && b.x <= o.x + o.w && b.y >= o.y && b.y <= o.y + o.h);
}

function playerHitsObstacle(x, y) {
  return OBSTACLES.some(o => rectCircleCollide(o, x, y, PLAYER_RADIUS));
}

function addKillFeed(killer, victim, weapon) {
  gameState.killFeed.unshift({ killer, victim, weapon, time: Date.now() });
  if (gameState.killFeed.length > 5) gameState.killFeed.pop();
}

function makePlayer(id, isBot = false) {
  return {
    id, isBot,
    x: id === 'p1' ? 120 : W - 120,
    y: H / 2,
    hp: MAX_HP, lives: MAX_LIVES,
    angle: id === 'p1' ? 0 : Math.PI,
    weapon: 'pistol', speed: 4,
    shield: false, rapidfire: false, invincible: false, tripleshot: false,
    dashCooldown: 0, dead: false, respawnTimer: 0,
    kills: 0, deaths: 0, damageDealt: 0, shotsFired: 0
  };
}

function spawnPowerup() {
  if (gameState.phase !== 'playing' || gameState.powerups.length >= 5) return;
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  let x, y, tries = 0;
  do { x = 80 + Math.random() * (W - 160); y = 80 + Math.random() * (H - 160); tries++; }
  while (playerHitsObstacle(x, y) && tries < 20);
  gameState.powerups.push({ id: Date.now() + Math.random(), type, x, y });
}

function spawnHazard() {
  if (gameState.phase !== 'playing' || gameState.hazardZones.length >= 3) return;
  let x, y;
  do { x = 100 + Math.random() * (W - 200); y = 100 + Math.random() * (H - 200); }
  while (playerHitsObstacle(x, y));
  gameState.hazardZones.push({ id: Date.now(), x, y, r: 55, life: 600, pulse: 0 });
}

function resetRound() {
  for (const p of Object.values(gameState.players)) {
    p.x = p.id === 'p1' ? 120 : W - 120;
    p.y = H / 2;
    p.hp = MAX_HP; p.angle = p.id === 'p1' ? 0 : Math.PI;
    p.weapon = 'pistol'; p.speed = 4;
    p.shield = false; p.rapidfire = false; p.invincible = false; p.tripleshot = false;
    p.dead = false;
  }
  playerAmmo = {};
  for (const pid of Object.keys(gameState.players)) {
    playerAmmo[pid] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
  }
  gameState.bullets = []; gameState.grenades = [];
  gameState.explosions = []; gameState.powerups = [];
  gameState.hazardZones = [];
  gameState.phase = 'playing';
  if (powerupTimer) clearInterval(powerupTimer);
  powerupTimer = setInterval(spawnPowerup, 4500);
  setTimeout(spawnPowerup, 800);
  setTimeout(spawnHazard, 8000);
  setInterval(spawnHazard, 12000);
}

function resetMatch() {
  for (const p of Object.values(gameState.players)) {
    p.lives = MAX_LIVES; p.hp = MAX_HP;
    p.kills = 0; p.deaths = 0; p.damageDealt = 0; p.shotsFired = 0;
  }
  gameState.scores = { p1: 0, p2: 0 };
  gameState.roundNum = 1;
  gameState.killFeed = [];
  gameState.chatMessages = [];
  resetRound();
}

function movePlayer(p, input) {
  if (p.dead) return;
  const spd = p.speed || 4;
  let nx = p.x, ny = p.y;
  if (input.up)    ny -= spd;
  if (input.down)  ny += spd;
  if (input.left)  nx -= spd;
  if (input.right) nx += spd;
  nx = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, nx));
  ny = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, ny));
  if (!playerHitsObstacle(nx, ny)) { p.x = nx; p.y = ny; }
  else if (!playerHitsObstacle(nx, p.y)) p.x = nx;
  else if (!playerHitsObstacle(p.x, ny)) p.y = ny;
}

function handleShoot(p, now) {
  const wep = WEAPONS[p.weapon] || WEAPONS.pistol;
  const cooldown = p.rapidfire ? wep.cooldown * 0.4 : wep.cooldown;
  if (now - (lastBulletTime[p.id] || 0) < cooldown) return;

  // Ammo check
  const ammo = playerAmmo[p.id] || {};
  if (wep.ammo !== Infinity && (ammo[p.weapon] || 0) <= 0) {
    // Auto-switch to pistol
    p.weapon = 'pistol';
    return;
  }

  lastBulletTime[p.id] = now;
  if (p.shotsFired !== undefined) p.shotsFired++;

  if (wep.ammo !== Infinity) {
    ammo[p.weapon] = (ammo[p.weapon] || 0) - 1;
    if (ammo[p.weapon] <= 0) {
      io.emit('ammoEmpty', { pid: p.id, weapon: p.weapon });
      setTimeout(() => { if (gameState.players[p.id]) gameState.players[p.id].weapon = 'pistol'; }, 100);
    }
  }

  const count = p.tripleshot ? wep.bullets + 2 : wep.bullets;
  const baseSpread = wep.spread;

  for (let i = 0; i < count; i++) {
    let spread;
    if (p.tripleshot && wep.bullets === 1) {
      spread = (i - 1) * 0.18;
    } else {
      spread = (Math.random() - 0.5) * baseSpread;
    }
    const ang = p.angle + spread;
    gameState.bullets.push({
      id: now + p.id + i + Math.random(),
      owner: p.id, weapon: p.weapon, damage: wep.damage,
      x: p.x + Math.cos(ang) * (PLAYER_RADIUS + 6),
      y: p.y + Math.sin(ang) * (PLAYER_RADIUS + 6),
      vx: Math.cos(ang) * wep.speed,
      vy: Math.sin(ang) * wep.speed,
      color: wep.color,
      explosive: wep.explosive || false
    });
  }
}

function handleGrenade(p, now) {
  if (now - (lastGrenadeTime[p.id] || 0) < 2000) return;
  lastGrenadeTime[p.id] = now;
  gameState.grenades.push({
    id: now + p.id + 'g', owner: p.id,
    x: p.x + Math.cos(p.angle) * 24,
    y: p.y + Math.sin(p.angle) * 24,
    vx: Math.cos(p.angle) * 5,
    vy: Math.sin(p.angle) * 5,
    fuse: 120, bounced: 0
  });
}

function handleDash(p, now) {
  if (now - (lastDashTime[p.id] || 0) < 1200) return;
  lastDashTime[p.id] = now;
  const dx = Math.cos(p.angle) * 80;
  const dy = Math.sin(p.angle) * 80;
  let nx = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, p.x + dx));
  let ny = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, p.y + dy));
  if (!playerHitsObstacle(nx, ny)) { p.x = nx; p.y = ny; }
  io.emit('dashEffect', { id: p.id, x: p.x, y: p.y });
}

function handleRespawn(p) {
  if (!p.dead) return;
  p.respawnTimer--;
  if (p.respawnTimer <= 0) {
    p.dead = false; p.hp = MAX_HP;
    p.x = p.id === 'p1' ? 120 : W - 120;
    p.y = H / 2;
    p.weapon = 'pistol'; p.shield = false; p.rapidfire = false;
    p.invincible = false; p.tripleshot = false;
    playerAmmo[p.id] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
    io.emit('respawnEffect', { id: p.id });
  }
}

// ── AI Bot logic ──────────────────────────────────────────────
function tickBot() {
  const bot = gameState.players['p2'];
  if (!bot || !bot.isBot || bot.dead || gameState.phase !== 'playing') return;
  const target = gameState.players['p1'];
  if (!target || target.dead) return;

  const dx = target.x - bot.x, dy = target.y - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  bot.angle = Math.atan2(dy, dx);

  const now = Date.now();
  const input = { up: false, down: false, left: false, right: false };

  // Smarter movement with periodic strafing
  const strafe = Math.sin(now / 700);
  const preferredDist = bot.weapon === 'sniper' ? 280 : bot.weapon === 'shotgun' ? 140 : 190;

  if (dist > preferredDist + 40) {
    input.right = dx > 0; input.left = dx < 0;
    input.down = dy > 0; input.up = dy < 0;
  } else if (dist < preferredDist - 40) {
    input.left = dx > 0; input.right = dx < 0;
    input.up = dy > 0; input.down = dy < 0;
  } else {
    // Strafe perpendicular
    const perpX = -dy / dist, perpY = dx / dist;
    input.right = strafe > 0 ? perpX > 0 : perpX < 0;
    input.left  = strafe > 0 ? perpX < 0 : perpX > 0;
    input.down  = strafe > 0 ? perpY > 0 : perpY < 0;
    input.up    = strafe > 0 ? perpY < 0 : perpY > 0;
  }

  // Dodge incoming bullets
  for (const b of gameState.bullets) {
    if (b.owner === 'p2') continue;
    const bx = b.x - bot.x, by = b.y - bot.y;
    if (Math.sqrt(bx*bx+by*by) < 120) {
      input.up = by > 0; input.down = by < 0;
      input.left = bx > 0; input.right = bx < 0;
    }
  }

  // Avoid hazard zones
  for (const hz of gameState.hazardZones) {
    const hdx = bot.x - hz.x, hdy = bot.y - hz.y;
    if (Math.sqrt(hdx*hdx+hdy*hdy) < hz.r + 40) {
      input.right = hdx > 0; input.left = hdx < 0;
      input.down = hdy > 0; input.up = hdy < 0;
    }
  }

  movePlayer(bot, input);

  if (dist < 380) handleShoot(bot, now);
  if (dist < 160 && Math.random() < 0.025) handleGrenade(bot, now);
  if (dist < 100 && Math.random() < 0.04) handleDash(bot, now);

  // Collect nearby powerups
  for (const pu of gameState.powerups) {
    const pd = Math.sqrt((pu.x-bot.x)**2 + (pu.y-bot.y)**2);
    if (pd < PLAYER_RADIUS + 14) applyPowerup(bot, pu);
  }
}

function applyPowerup(p, pu) {
  const pid = p.id;
  const ammo = playerAmmo[pid] || {};
  if (pu.type === 'speed')           { p.speed = 7; setTimeout(() => { if (gameState.players[pid]) gameState.players[pid].speed = 4; }, 5000); }
  else if (pu.type === 'shield')     { p.shield = true; }
  else if (pu.type === 'rapidfire')  { p.rapidfire = true; setTimeout(() => { if (gameState.players[pid]) gameState.players[pid].rapidfire = false; }, 6000); }
  else if (pu.type === 'invincible') { p.invincible = true; setTimeout(() => { if (gameState.players[pid]) gameState.players[pid].invincible = false; }, 4000); }
  else if (pu.type === 'tripleshot') { p.tripleshot = true; setTimeout(() => { if (gameState.players[pid]) gameState.players[pid].tripleshot = false; }, 7000); }
  else if (pu.type === 'weapon_shotgun') { p.weapon = 'shotgun'; ammo['shotgun'] = (ammo['shotgun']||0) + WEAPONS.shotgun.ammo; }
  else if (pu.type === 'weapon_sniper')  { p.weapon = 'sniper';  ammo['sniper']  = (ammo['sniper']||0)  + WEAPONS.sniper.ammo; }
  else if (pu.type === 'weapon_smg')     { p.weapon = 'smg';     ammo['smg']     = (ammo['smg']||0)     + WEAPONS.smg.ammo; }
  else if (pu.type === 'weapon_rocket')  { p.weapon = 'rocket';  ammo['rocket']  = (ammo['rocket']||0)  + WEAPONS.rocket.ammo; }
  else if (pu.type === 'healthpack') { p.hp = Math.min(MAX_HP, p.hp + 2); }
  playerAmmo[pid] = ammo;
  io.emit('powerupCollected', { pid, type: pu.type, x: pu.x, y: pu.y });
  gameState.powerups = gameState.powerups.filter(p2 => p2.id !== pu.id);
  io.emit('ammoUpdate', { pid, ammo: playerAmmo[pid] });
}

function explodeAt(x, y, ownerPid, weapon) {
  io.emit('explosion', { x, y, r: 90 });
  for (const [pid, p] of Object.entries(gameState.players)) {
    if (p.dead) continue;
    const dx = x - p.x, dy = y - p.y;
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist < 90) {
      const dmg = dist < 40 ? 4 : dist < 70 ? 2 : 1;
      if (p.invincible) return;
      if (p.shield) { p.shield = false; return; }
      p.hp -= dmg;
      if (p.damageDealt !== undefined && pid !== ownerPid) {
        const attacker = gameState.players[ownerPid];
        if (attacker) attacker.damageDealt = (attacker.damageDealt||0) + dmg;
      }
      io.emit('hitEffect', { x: p.x, y: p.y, type: 'hit' });
      if (p.hp <= 0) killPlayer(p, ownerPid, weapon);
    }
  }
}

function killPlayer(p, killerPid, weapon) {
  p.hp = 0;
  addKillFeed(killerPid, p.id, weapon);
  io.emit('hitEffect', { x: p.x, y: p.y, type: 'death' });
  if (p.deaths !== undefined) p.deaths++;
  const killer = gameState.players[killerPid];
  if (killer && killer.kills !== undefined) killer.kills++;

  // Drop health pack on death
  gameState.powerups.push({ id: Date.now() + Math.random(), type: 'healthpack', x: p.x, y: p.y });

  if (p.lives > 1) {
    p.lives--;
    p.dead = true;
    p.respawnTimer = 180;
    io.emit('playerDied', { id: p.id, lives: p.lives });
  } else {
    p.lives = 0;
    gameState.scores[killerPid]++;
    gameState.roundNum++;
    const matchStats = {
      winner: killerPid,
      scores: gameState.scores,
      killFeed: gameState.killFeed,
      stats: {}
    };
    for (const [pid, pl] of Object.entries(gameState.players)) {
      matchStats.stats[pid] = {
        kills: pl.kills || 0,
        deaths: pl.deaths || 0,
        damageDealt: pl.damageDealt || 0,
        shotsFired: pl.shotsFired || 0,
        isBot: pl.isBot
      };
    }
    gameState.phase = 'matchOver';
    gameState.matchStats = matchStats;
    io.emit('matchOver', matchStats);
    setTimeout(() => { resetMatch(); io.emit('stateUpdate', gameState); }, 4000);
  }
}

// ── Main game tick ─────────────────────────────────────────────
function gameTick() {
  if (gameState.phase !== 'playing') return;
  const now = Date.now();

  // Respawn dead players
  for (const p of Object.values(gameState.players)) handleRespawn(p);

  // Hazard zones tick
  gameState.hazardZones = gameState.hazardZones.filter(hz => {
    hz.life--;
    hz.pulse = (hz.pulse + 0.08) % (Math.PI * 2);
    if (hz.life <= 0) return false;
    for (const p of Object.values(gameState.players)) {
      if (p.dead || p.invincible) continue;
      const dx = p.x - hz.x, dy = p.y - hz.y;
      if (Math.sqrt(dx*dx+dy*dy) < hz.r) {
        if (now % 60 < 2) { // damage every ~1 second
          if (!p.shield) { p.hp -= 1; io.emit('hitEffect', { x: p.x, y: p.y, type: 'hit' }); }
          else p.shield = false;
          if (p.hp <= 0) killPlayer(p, 'hazard', 'hazard');
        }
      }
    }
    return true;
  });
  gameState.hazardZones.forEach(hz => hz.pulse = hz.pulse); // keep serializable

  // Bullets
  gameState.bullets = gameState.bullets.filter(b => {
    b.x += b.vx; b.y += b.vy;
    if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) return false;
    if (bulletHitsObstacle(b)) {
      io.emit('hitEffect', { x: b.x, y: b.y, type: 'wall' });
      if (b.explosive) explodeAt(b.x, b.y, b.owner, b.weapon);
      return false;
    }
    for (const [pid, p] of Object.entries(gameState.players)) {
      if (pid === b.owner || p.dead) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS + BULLET_RADIUS) {
        if (b.explosive) { explodeAt(b.x, b.y, b.owner, b.weapon); return false; }
        if (p.invincible) return false;
        if (p.shield) { p.shield = false; io.emit('hitEffect', { x: p.x, y: p.y, type: 'shield' }); return false; }
        p.hp -= b.damage;
        const attacker = gameState.players[b.owner];
        if (attacker) attacker.damageDealt = (attacker.damageDealt||0) + b.damage;
        io.emit('hitEffect', { x: p.x, y: p.y, type: 'hit' });
        if (p.hp <= 0) killPlayer(p, b.owner, b.weapon);
        return false;
      }
    }
    return true;
  });

  // Grenades
  gameState.grenades = gameState.grenades.filter(g => {
    g.x += g.vx; g.y += g.vy;
    g.vx *= 0.97; g.vy *= 0.97;
    if (g.x < 10 || g.x > W-10) { g.vx *= -0.7; g.bounced++; }
    if (g.y < 10 || g.y > H-10) { g.vy *= -0.7; g.bounced++; }
    for (const o of OBSTACLES) {
      if (g.x > o.x && g.x < o.x+o.w && g.y > o.y && g.y < o.y+o.h) {
        g.vx *= -0.7; g.vy *= -0.7; g.bounced++;
      }
    }
    g.fuse--;
    if (g.fuse <= 0 || g.bounced > 4) {
      explodeAt(g.x, g.y, g.owner, 'grenade');
      return false;
    }
    return true;
  });

  // Power-ups collection
  for (const pu of [...gameState.powerups]) {
    for (const p of Object.values(gameState.players)) {
      if (p.dead) continue;
      const dx = pu.x - p.x, dy = pu.y - p.y;
      if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS + 14) applyPowerup(p, pu);
    }
  }

  tickBot();

  // Send ammo info
  const ammoOut = {};
  for (const [pid, ammo] of Object.entries(playerAmmo)) ammoOut[pid] = ammo;
  gameState._ammo = ammoOut;

  io.emit('stateUpdate', gameState);
}

setInterval(gameTick, 1000 / 60);

// ── Socket connections ─────────────────────────────────────────
io.on('connection', (socket) => {
  const humanIds = Object.entries(gameState.players).filter(([,p]) => !p.isBot).map(([id]) => id);
  if (humanIds.length >= 2) { socket.emit('full'); return; }

  const playerId = humanIds.length === 0 ? 'p1' : 'p2';
  socket.playerId = playerId;
  gameState.players[playerId] = makePlayer(playerId, false);
  playerAmmo[playerId] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
  lastBulletTime[playerId] = 0;
  lastGrenadeTime[playerId] = 0;
  lastDashTime[playerId] = 0;

  socket.emit('assignId', playerId);
  socket.emit('obstacles', OBSTACLES);
  io.emit('stateUpdate', gameState);

  const humanCount = Object.values(gameState.players).filter(p => !p.isBot).length;

  if (humanCount === 1 && !gameState.players['p2']) {
    gameState.players['p2'] = makePlayer('p2', true);
    playerAmmo['p2'] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
    io.emit('botJoined');
    resetMatch();
    io.emit('stateUpdate', gameState);
  } else if (humanCount === 2) {
    if (gameState.players['p2'] && gameState.players['p2'].isBot) {
      delete gameState.players['p2'];
      gameState.players['p2'] = makePlayer('p2', false);
      playerAmmo['p2'] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
    }
    resetMatch();
    io.emit('stateUpdate', gameState);
  }

  socket.on('input', (input) => {
    const p = gameState.players[playerId];
    if (!p || p.isBot || p.dead || gameState.phase !== 'playing') return;
    const now = Date.now();

    movePlayer(p, input);

    // Use mouse angle if provided, else auto-aim
    if (typeof input.aimAngle === 'number') {
      p.angle = input.aimAngle;
    } else {
      const other = Object.values(gameState.players).find(op => op.id !== playerId && !op.dead);
      if (other) p.angle = Math.atan2(other.y - p.y, other.x - p.x);
    }

    if (input.shoot) handleShoot(p, now);
    if (input.grenade) handleGrenade(p, now);
    if (input.dash) handleDash(p, now);

    // Weapon switch
    if (input.switchWeapon && WEAPONS[input.switchWeapon]) {
      const ammo = playerAmmo[playerId] || {};
      if (input.switchWeapon === 'pistol' || (ammo[input.switchWeapon] || 0) > 0) {
        p.weapon = input.switchWeapon;
      }
    }
  });

  socket.on('chat', (msg) => {
    if (!msg || typeof msg !== 'string') return;
    const clean = msg.slice(0, 50).replace(/</g,'&lt;');
    const entry = { pid: playerId, text: clean, time: Date.now() };
    gameState.chatMessages.unshift(entry);
    if (gameState.chatMessages.length > 10) gameState.chatMessages.pop();
    io.emit('chatMessage', entry);
  });

  socket.on('disconnect', () => {
    delete gameState.players[playerId];
    delete playerAmmo[playerId];
    gameState.bullets = []; gameState.grenades = [];
    gameState.powerups = []; gameState.phase = 'waiting';
    gameState.hazardZones = [];
    if (powerupTimer) { clearInterval(powerupTimer); powerupTimer = null; }
    io.emit('stateUpdate', gameState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game on http://localhost:${PORT}`));
