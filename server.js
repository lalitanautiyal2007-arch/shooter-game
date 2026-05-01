const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const W = 800, H = 560;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_HP = 5;
const MAX_LIVES = 3;

const WEAPONS = {
  pistol:  { speed: 8,  damage: 1, cooldown: 250,  bullets: 1, spread: 0,    color: '#81d4fa', ammo: Infinity },
  shotgun: { speed: 7,  damage: 1, cooldown: 600,  bullets: 5, spread: 0.25, color: '#ffcc80', ammo: 12 },
  sniper:  { speed: 18, damage: 3, cooldown: 900,  bullets: 1, spread: 0,    color: '#ce93d8', ammo: 6  },
  smg:     { speed: 9,  damage: 1, cooldown: 100,  bullets: 1, spread: 0.08, color: '#a5d6a7', ammo: 30 },
  rocket:  { speed: 6,  damage: 4, cooldown: 1800, bullets: 1, spread: 0,    color: '#ff7043', ammo: 3,  explosive: true }
};

const POWERUP_TYPES = [
  'speed','shield','rapidfire','weapon_shotgun','weapon_sniper',
  'weapon_smg','weapon_rocket','healthpack','invincible','tripleshot'
];

const OBSTACLES = [
  { x: 180, y: 180, w: 20, h: 140 },
  { x: 600, y: 180, w: 20, h: 140 },
  { x: 340, y: 60,  w: 120, h: 20 },
  { x: 340, y: 480, w: 120, h: 20 },
  { x: 260, y: 270, w: 80,  h: 20 },
  { x: 460, y: 270, w: 80,  h: 20 },
  { x: 80,  y: 90,  w: 20,  h: 80  },
  { x: 680, y: 390, w: 20,  h: 80  },
  { x: 340, y: 220, w: 120, h: 20  },
  { x: 100, y: 300, w: 60,  h: 20  },
  { x: 640, y: 240, w: 60,  h: 20  },
];

// ── Room management ───────────────────────────────────────────
// Each room: { id, players:{p1,p2}, gameState, timers... }
const rooms = new Map();

function createRoom(id) {
  const gs = {
    players: {}, bullets: [], grenades: [], explosions: [],
    powerups: [], scores: { p1: 0, p2: 0 },
    phase: 'waiting', obstacles: OBSTACLES, killFeed: [],
    hazardZones: [], roundNum: 1, matchStats: null, chatMessages: [],
    roomId: id
  };
  const room = {
    id,
    gameState: gs,
    lastBulletTime: {},
    lastGrenadeTime: {},
    lastDashTime: {},
    playerAmmo: {},
    powerupTimer: null,
    hazardTimer: 0,
    tickInterval: null
  };
  rooms.set(id, room);
  return room;
}

function findAvailableRoom() {
  for (const [id, room] of rooms) {
    const humans = Object.values(room.gameState.players).filter(p => !p.isBot);
    if (humans.length < 2) return room;
  }
  return null;
}

function getRoomById(id) {
  return rooms.get(id);
}

function generateRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Helpers ───────────────────────────────────────────────────
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

function addKillFeed(gs, killer, victim, weapon) {
  gs.killFeed.unshift({ killer, victim, weapon, time: Date.now() });
  if (gs.killFeed.length > 5) gs.killFeed.pop();
}

function makePlayer(id, isBot = false) {
  return {
    id, isBot,
    x: id === 'p1' ? 130 : W - 130,
    y: H / 2,
    hp: MAX_HP, lives: MAX_LIVES,
    angle: id === 'p1' ? 0 : Math.PI,
    weapon: 'pistol', speed: 4,
    shield: false, rapidfire: false, invincible: false, tripleshot: false,
    dashCooldown: 0, dead: false, respawnTimer: 0,
    kills: 0, deaths: 0, damageDealt: 0, shotsFired: 0
  };
}

function spawnPowerup(room) {
  const gs = room.gameState;
  if (gs.phase !== 'playing' || gs.powerups.length >= 5) return;
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  let x, y, tries = 0;
  do { x = 80 + Math.random() * (W - 160); y = 80 + Math.random() * (H - 160); tries++; }
  while (playerHitsObstacle(x, y) && tries < 20);
  gs.powerups.push({ id: Date.now() + Math.random(), type, x, y });
}

function spawnHazard(room) {
  const gs = room.gameState;
  if (gs.phase !== 'playing' || gs.hazardZones.length >= 3) return;
  let x, y, tries = 0;
  do { x = 80 + Math.random() * (W - 160); y = 80 + Math.random() * (H - 160); tries++; }
  while (playerHitsObstacle(x, y) && tries < 20);
  gs.hazardZones.push({
    id: Date.now() + Math.random(), x, y,
    r: 55 + Math.random() * 40,
    life: 600 + Math.floor(Math.random() * 300),
    pulse: 0
  });
}

function resetMatch(room) {
  const gs = room.gameState;
  gs.bullets = []; gs.grenades = []; gs.powerups = [];
  gs.hazardZones = []; gs.killFeed = [];
  room.hazardTimer = 0;

  if (room.powerupTimer) { clearInterval(room.powerupTimer); room.powerupTimer = null; }

  for (const p of Object.values(gs.players)) {
    p.hp = MAX_HP; p.lives = MAX_LIVES;
    p.x = p.id === 'p1' ? 130 : W - 130;
    p.y = H / 2;
    p.weapon = 'pistol'; p.shield = false; p.rapidfire = false;
    p.invincible = false; p.tripleshot = false;
    p.dead = false; p.respawnTimer = 0;
    p.kills = 0; p.deaths = 0; p.damageDealt = 0; p.shotsFired = 0;
    room.playerAmmo[p.id] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
  }

  gs.phase = 'playing';
  room.powerupTimer = setInterval(() => spawnPowerup(room), 4000);
  setTimeout(() => spawnHazard(room), 15000);
}

function movePlayer(p, input) {
  let dx = 0, dy = 0;
  if (input.up)    dy -= 1;
  if (input.down)  dy += 1;
  if (input.left)  dx -= 1;
  if (input.right) dx += 1;
  if (dx && dy) { dx *= 0.707; dy *= 0.707; }
  const spd = p.speed || 4;
  let nx = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, p.x + dx * spd));
  let ny = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, p.y + dy * spd));
  if (!playerHitsObstacle(nx, p.y)) p.x = nx;
  if (!playerHitsObstacle(p.x, ny)) p.y = ny;
}

function handleShoot(p, now, room) {
  const gs = room.gameState;
  const ammo = room.playerAmmo[p.id] || {};
  const wep = WEAPONS[p.weapon];
  const cd = p.rapidfire ? wep.cooldown * 0.4 : wep.cooldown;
  if (now - (room.lastBulletTime[p.id] || 0) < cd) return;
  if (wep.ammo !== Infinity && (ammo[p.weapon] || 0) <= 0) return;
  room.lastBulletTime[p.id] = now;
  if (p.shotsFired !== undefined) p.shotsFired++;

  if (wep.ammo !== Infinity) {
    ammo[p.weapon] = (ammo[p.weapon] || 0) - 1;
    if (ammo[p.weapon] <= 0) {
      io.to(room.id).emit('ammoEmpty', { pid: p.id, weapon: p.weapon });
      setTimeout(() => { if (gs.players[p.id]) gs.players[p.id].weapon = 'pistol'; }, 100);
    }
  }

  const count = p.tripleshot ? wep.bullets + 2 : wep.bullets;
  for (let i = 0; i < count; i++) {
    let spread;
    if (p.tripleshot && wep.bullets === 1) spread = (i - 1) * 0.18;
    else spread = (Math.random() - 0.5) * wep.spread;
    const ang = p.angle + spread;
    gs.bullets.push({
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

function handleGrenade(p, now, room) {
  if (now - (room.lastGrenadeTime[p.id] || 0) < 2000) return;
  room.lastGrenadeTime[p.id] = now;
  room.gameState.grenades.push({
    id: now + p.id + 'g', owner: p.id,
    x: p.x + Math.cos(p.angle) * 24,
    y: p.y + Math.sin(p.angle) * 24,
    vx: Math.cos(p.angle) * 5,
    vy: Math.sin(p.angle) * 5,
    fuse: 120, bounced: 0
  });
}

function handleDash(p, now, room) {
  if (now - (room.lastDashTime[p.id] || 0) < 1200) return;
  room.lastDashTime[p.id] = now;
  const dx = Math.cos(p.angle) * 80;
  const dy = Math.sin(p.angle) * 80;
  let nx = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, p.x + dx));
  let ny = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, p.y + dy));
  if (!playerHitsObstacle(nx, ny)) { p.x = nx; p.y = ny; }
  io.to(room.id).emit('dashEffect', { id: p.id, x: p.x, y: p.y });
}

function handleRespawn(p, room) {
  if (!p.dead) return;
  p.respawnTimer--;
  if (p.respawnTimer <= 0) {
    p.dead = false; p.hp = MAX_HP;
    p.x = p.id === 'p1' ? 130 : W - 130;
    p.y = H / 2;
    p.weapon = 'pistol'; p.shield = false; p.rapidfire = false;
    p.invincible = false; p.tripleshot = false;
    room.playerAmmo[p.id] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
    io.to(room.id).emit('respawnEffect', { id: p.id });
  }
}

// ── AUTO-AIM ──────────────────────────────────────────────────
// Server always computes aim angle toward the nearest enemy
function computeAutoAim(p, gs) {
  const enemies = Object.values(gs.players).filter(op => op.id !== p.id && !op.dead);
  if (!enemies.length) return p.angle;
  let best = enemies[0], bestDist = Infinity;
  for (const e of enemies) {
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return Math.atan2(best.y - p.y, best.x - p.x);
}

// ── AI Bot logic ──────────────────────────────────────────────
function tickBot(room) {
  const gs = room.gameState;
  const bot = gs.players['p2'];
  if (!bot || !bot.isBot || bot.dead || gs.phase !== 'playing') return;
  const target = gs.players['p1'];
  if (!target || target.dead) return;

  const dx = target.x - bot.x, dy = target.y - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  bot.angle = Math.atan2(dy, dx);

  const now = Date.now();
  const input = { up: false, down: false, left: false, right: false };

  const strafe = Math.sin(now / 700);
  const preferredDist = bot.weapon === 'sniper' ? 280 : bot.weapon === 'shotgun' ? 140 : 190;

  if (dist > preferredDist + 40) {
    input.right = dx > 0; input.left = dx < 0;
    input.down = dy > 0; input.up = dy < 0;
  } else if (dist < preferredDist - 40) {
    input.left = dx > 0; input.right = dx < 0;
    input.up = dy > 0; input.down = dy < 0;
  } else {
    const perpX = -dy / dist, perpY = dx / dist;
    input.right = strafe > 0 ? perpX > 0 : perpX < 0;
    input.left  = strafe > 0 ? perpX < 0 : perpX > 0;
    input.down  = strafe > 0 ? perpY > 0 : perpY < 0;
    input.up    = strafe > 0 ? perpY < 0 : perpY > 0;
  }

  for (const b of gs.bullets) {
    if (b.owner === 'p2') continue;
    const bx = b.x - bot.x, by = b.y - bot.y;
    if (Math.sqrt(bx*bx+by*by) < 120) {
      input.up = by > 0; input.down = by < 0;
      input.left = bx > 0; input.right = bx < 0;
    }
  }

  for (const hz of gs.hazardZones) {
    const hdx = bot.x - hz.x, hdy = bot.y - hz.y;
    if (Math.sqrt(hdx*hdx+hdy*hdy) < hz.r + 40) {
      input.right = hdx > 0; input.left = hdx < 0;
      input.down = hdy > 0; input.up = hdy < 0;
    }
  }

  movePlayer(bot, input);

  if (dist < 380) handleShoot(bot, now, room);
  if (dist < 160 && Math.random() < 0.025) handleGrenade(bot, now, room);
  if (dist < 100 && Math.random() < 0.04) handleDash(bot, now, room);

  for (const pu of gs.powerups) {
    const pd = Math.sqrt((pu.x-bot.x)**2 + (pu.y-bot.y)**2);
    if (pd < PLAYER_RADIUS + 14) applyPowerup(bot, pu, room);
  }
}

function applyPowerup(p, pu, room) {
  const pid = p.id;
  const gs = room.gameState;
  const ammo = room.playerAmmo[pid] || {};
  if (pu.type === 'speed')           { p.speed = 7; setTimeout(() => { if (gs.players[pid]) gs.players[pid].speed = 4; }, 5000); }
  else if (pu.type === 'shield')     { p.shield = true; }
  else if (pu.type === 'rapidfire')  { p.rapidfire = true; setTimeout(() => { if (gs.players[pid]) gs.players[pid].rapidfire = false; }, 6000); }
  else if (pu.type === 'invincible') { p.invincible = true; setTimeout(() => { if (gs.players[pid]) gs.players[pid].invincible = false; }, 4000); }
  else if (pu.type === 'tripleshot') { p.tripleshot = true; setTimeout(() => { if (gs.players[pid]) gs.players[pid].tripleshot = false; }, 7000); }
  else if (pu.type === 'weapon_shotgun') { p.weapon = 'shotgun'; ammo['shotgun'] = (ammo['shotgun']||0) + WEAPONS.shotgun.ammo; }
  else if (pu.type === 'weapon_sniper')  { p.weapon = 'sniper';  ammo['sniper']  = (ammo['sniper']||0)  + WEAPONS.sniper.ammo; }
  else if (pu.type === 'weapon_smg')     { p.weapon = 'smg';     ammo['smg']     = (ammo['smg']||0)     + WEAPONS.smg.ammo; }
  else if (pu.type === 'weapon_rocket')  { p.weapon = 'rocket';  ammo['rocket']  = (ammo['rocket']||0)  + WEAPONS.rocket.ammo; }
  else if (pu.type === 'healthpack') { p.hp = Math.min(MAX_HP, p.hp + 2); }
  room.playerAmmo[pid] = ammo;
  io.to(room.id).emit('powerupCollected', { pid, type: pu.type, x: pu.x, y: pu.y });
  gs.powerups = gs.powerups.filter(p2 => p2.id !== pu.id);
  io.to(room.id).emit('ammoUpdate', { pid, ammo: room.playerAmmo[pid] });
}

function explodeAt(x, y, ownerPid, weapon, room) {
  const gs = room.gameState;
  io.to(room.id).emit('explosion', { x, y, r: 90 });
  for (const [pid, p] of Object.entries(gs.players)) {
    if (p.dead) continue;
    const dx = x - p.x, dy = y - p.y;
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist < 90) {
      const dmg = dist < 40 ? 4 : dist < 70 ? 2 : 1;
      if (p.invincible) continue;
      if (p.shield) { p.shield = false; continue; }
      p.hp -= dmg;
      if (pid !== ownerPid) {
        const attacker = gs.players[ownerPid];
        if (attacker) attacker.damageDealt = (attacker.damageDealt||0) + dmg;
      }
      io.to(room.id).emit('hitEffect', { x: p.x, y: p.y, type: 'hit' });
      if (p.hp <= 0) killPlayer(p, ownerPid, weapon, room);
    }
  }
}

function killPlayer(p, killerPid, weapon, room) {
  const gs = room.gameState;
  p.hp = 0;
  addKillFeed(gs, killerPid, p.id, weapon);
  io.to(room.id).emit('hitEffect', { x: p.x, y: p.y, type: 'death' });
  if (p.deaths !== undefined) p.deaths++;
  const killer = gs.players[killerPid];
  if (killer && killer.kills !== undefined) killer.kills++;

  gs.powerups.push({ id: Date.now() + Math.random(), type: 'healthpack', x: p.x, y: p.y });

  if (p.lives > 1) {
    p.lives--;
    p.dead = true;
    p.respawnTimer = 180;
    io.to(room.id).emit('playerDied', { id: p.id, lives: p.lives });
  } else {
    p.lives = 0;
    gs.scores[killerPid]++;
    gs.roundNum++;
    const matchStats = {
      winner: killerPid,
      scores: gs.scores,
      killFeed: gs.killFeed,
      stats: {}
    };
    for (const [pid, pl] of Object.entries(gs.players)) {
      matchStats.stats[pid] = {
        kills: pl.kills || 0, deaths: pl.deaths || 0,
        damageDealt: pl.damageDealt || 0, shotsFired: pl.shotsFired || 0,
        isBot: pl.isBot
      };
    }
    gs.phase = 'matchOver';
    gs.matchStats = matchStats;
    io.to(room.id).emit('matchOver', matchStats);
    setTimeout(() => {
      resetMatch(room);
      io.to(room.id).emit('stateUpdate', gs);
    }, 4500);
  }
}

// ── Main game tick per room ────────────────────────────────────
function makeGameTick(room) {
  return function() {
    const gs = room.gameState;
    if (gs.phase !== 'playing') return;
    const now = Date.now();

    for (const p of Object.values(gs.players)) handleRespawn(p, room);

    // Hazard zones
    room.hazardTimer++;
    if (room.hazardTimer % 900 === 0) spawnHazard(room);

    gs.hazardZones = gs.hazardZones.filter(hz => {
      hz.life--;
      hz.pulse = (hz.pulse + 0.08) % (Math.PI * 2);
      if (hz.life <= 0) return false;
      for (const p of Object.values(gs.players)) {
        if (p.dead || p.invincible) continue;
        const dx = p.x - hz.x, dy = p.y - hz.y;
        if (Math.sqrt(dx*dx+dy*dy) < hz.r) {
          if (now % 60 < 2) {
            if (!p.shield) { p.hp -= 1; io.to(room.id).emit('hitEffect', { x: p.x, y: p.y, type: 'hit' }); }
            else p.shield = false;
            if (p.hp <= 0) killPlayer(p, 'hazard', 'hazard', room);
          }
        }
      }
      return true;
    });

    // Bullets
    gs.bullets = gs.bullets.filter(b => {
      b.x += b.vx; b.y += b.vy;
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) return false;
      if (bulletHitsObstacle(b)) {
        io.to(room.id).emit('hitEffect', { x: b.x, y: b.y, type: 'wall' });
        if (b.explosive) explodeAt(b.x, b.y, b.owner, b.weapon, room);
        return false;
      }
      for (const [pid, p] of Object.entries(gs.players)) {
        if (pid === b.owner || p.dead) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS + BULLET_RADIUS) {
          if (b.explosive) { explodeAt(b.x, b.y, b.owner, b.weapon, room); return false; }
          if (p.invincible) return false;
          if (p.shield) { p.shield = false; io.to(room.id).emit('hitEffect', { x: p.x, y: p.y, type: 'shield' }); return false; }
          p.hp -= b.damage;
          const attacker = gs.players[b.owner];
          if (attacker) attacker.damageDealt = (attacker.damageDealt||0) + b.damage;
          io.to(room.id).emit('hitEffect', { x: p.x, y: p.y, type: 'hit' });
          if (p.hp <= 0) killPlayer(p, b.owner, b.weapon, room);
          return false;
        }
      }
      return true;
    });

    // Grenades
    gs.grenades = gs.grenades.filter(g => {
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
        explodeAt(g.x, g.y, g.owner, 'grenade', room);
        return false;
      }
      return true;
    });

    // Power-up collection
    for (const pu of [...gs.powerups]) {
      for (const p of Object.values(gs.players)) {
        if (p.dead) continue;
        const dx = pu.x - p.x, dy = pu.y - p.y;
        if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS + 14) applyPowerup(p, pu, room);
      }
    }

    tickBot(room);

    // Build ammo snapshot
    const ammoOut = {};
    for (const [pid, ammo] of Object.entries(room.playerAmmo)) ammoOut[pid] = ammo;
    gs._ammo = ammoOut;

    io.to(room.id).emit('stateUpdate', gs);
  };
}

// ── Socket connections ─────────────────────────────────────────
io.on('connection', (socket) => {
  let joinedRoom = null;
  let playerId = null;

  // Client sends preferred mode: 'pvp' (join/create any room), 'ai' (solo vs bot), 'room:<id>' (specific room)
  socket.on('joinGame', ({ mode }) => {
    getAudio_socket();
    let room;

    if (mode === 'ai') {
      // Always create a fresh room for AI mode
      const rid = generateRoomId();
      room = createRoom(rid);
    } else if (mode && mode.startsWith('room:')) {
      const rid = mode.split(':')[1];
      room = getRoomById(rid);
      if (!room) {
        socket.emit('roomNotFound');
        return;
      }
      const humans = Object.values(room.gameState.players).filter(p => !p.isBot);
      if (humans.length >= 2) {
        socket.emit('full');
        return;
      }
    } else {
      // PvP: find room with space or create new
      room = findAvailableRoom();
      if (!room) {
        room = createRoom(generateRoomId());
      } else {
        const humans = Object.values(room.gameState.players).filter(p => !p.isBot);
        if (humans.length >= 2) {
          socket.emit('full');
          return;
        }
      }
    }

    joinedRoom = room;
    socket.join(room.id);

    const gs = room.gameState;
    const existingHumans = Object.values(gs.players).filter(p => !p.isBot).map(p => p.id);
    playerId = existingHumans.length === 0 ? 'p1' : 'p2';

    // Remove bot if human is joining as p2
    if (playerId === 'p2' && gs.players['p2'] && gs.players['p2'].isBot) {
      delete gs.players['p2'];
    }

    gs.players[playerId] = makePlayer(playerId, false);
    room.playerAmmo[playerId] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
    room.lastBulletTime[playerId] = 0;
    room.lastGrenadeTime[playerId] = 0;
    room.lastDashTime[playerId] = 0;

    socket.playerId = playerId;
    socket.emit('assignId', playerId);
    socket.emit('obstacles', OBSTACLES);
    socket.emit('roomAssigned', { roomId: room.id, mode });

    const humanCount = Object.values(gs.players).filter(p => !p.isBot).length;

    if (mode === 'ai' || (humanCount === 1 && !gs.players['p2'])) {
      // Add AI bot as p2
      gs.players['p2'] = makePlayer('p2', true);
      room.playerAmmo['p2'] = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
      room.lastBulletTime['p2'] = 0;
      room.lastGrenadeTime['p2'] = 0;
      room.lastDashTime['p2'] = 0;
      io.to(room.id).emit('botJoined');
      resetMatch(room);
    } else if (humanCount === 2) {
      resetMatch(room);
    }

    if (!room.tickInterval) {
      room.tickInterval = setInterval(makeGameTick(room), 1000 / 60);
    }

    io.to(room.id).emit('stateUpdate', gs);
  });

  // Legacy: allow direct connect without joinGame (backward compat)
  socket.on('legacyConnect', () => {
    socket.emit('needMenu');
  });

  socket.on('input', (input) => {
    if (!joinedRoom || !playerId) return;
    const room = joinedRoom;
    const gs = room.gameState;
    const p = gs.players[playerId];
    if (!p || p.isBot || p.dead || gs.phase !== 'playing') return;
    const now = Date.now();

    movePlayer(p, input);

    // AUTO-AIM: always aim at nearest enemy (no mouse needed)
    p.angle = computeAutoAim(p, gs);

    if (input.shoot) handleShoot(p, now, room);
    if (input.grenade) handleGrenade(p, now, room);
    if (input.dash) handleDash(p, now, room);

    // Weapon switch — validated server side
    if (input.switchWeapon && WEAPONS[input.switchWeapon]) {
      const ammo = room.playerAmmo[playerId] || {};
      if (input.switchWeapon === 'pistol' || (ammo[input.switchWeapon] || 0) > 0) {
        p.weapon = input.switchWeapon;
        io.to(room.id).emit('ammoUpdate', { pid: playerId, ammo: room.playerAmmo[playerId] });
      } else {
        socket.emit('ammoEmpty', { pid: playerId, weapon: input.switchWeapon });
      }
    }
  });

  socket.on('chat', (msg) => {
    if (!joinedRoom || !playerId) return;
    if (!msg || typeof msg !== 'string') return;
    const clean = msg.slice(0, 50).replace(/</g,'&lt;');
    const entry = { pid: playerId, text: clean, time: Date.now() };
    joinedRoom.gameState.chatMessages.unshift(entry);
    if (joinedRoom.gameState.chatMessages.length > 10) joinedRoom.gameState.chatMessages.pop();
    io.to(joinedRoom.id).emit('chatMessage', entry);
  });

  socket.on('disconnect', () => {
    if (!joinedRoom || !playerId) return;
    const room = joinedRoom;
    const gs = room.gameState;
    delete gs.players[playerId];
    delete room.playerAmmo[playerId];
    gs.bullets = []; gs.grenades = [];
    gs.powerups = []; gs.phase = 'waiting';
    gs.hazardZones = [];
    if (room.powerupTimer) { clearInterval(room.powerupTimer); room.powerupTimer = null; }

    const remaining = Object.keys(gs.players).length;
    if (remaining === 0) {
      if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
      rooms.delete(room.id);
    } else {
      io.to(room.id).emit('stateUpdate', gs);
    }
  });
});

function getAudio_socket() {} // placeholder to avoid lint

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Arena 2 running → http://localhost:${PORT}`));
