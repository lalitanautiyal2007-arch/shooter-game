const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const GAME_WIDTH = 800;
const GAME_HEIGHT = 500;
const PLAYER_SPEED = 4;
const BULLET_SPEED = 8;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_HP = 5;
const BULLET_COOLDOWN = 250;

let gameState = {
  players: {},
  bullets: [],
  scores: { p1: 0, p2: 0 },
  phase: 'waiting'
};

let lastBulletTime = {};

function resetPositions() {
  if (gameState.players['p1']) {
    gameState.players['p1'].x = 120;
    gameState.players['p1'].y = GAME_HEIGHT / 2;
    gameState.players['p1'].hp = MAX_HP;
  }
  if (gameState.players['p2']) {
    gameState.players['p2'].x = GAME_WIDTH - 120;
    gameState.players['p2'].y = GAME_HEIGHT / 2;
    gameState.players['p2'].hp = MAX_HP;
  }
  gameState.bullets = [];
  gameState.phase = 'playing';
}

io.on('connection', (socket) => {
  const existingIds = Object.keys(gameState.players);
  if (existingIds.length >= 2) {
    socket.emit('full');
    return;
  }

  const playerId = existingIds.length === 0 ? 'p1' : 'p2';
  socket.playerId = playerId;

  gameState.players[playerId] = {
    id: playerId,
    x: playerId === 'p1' ? 120 : GAME_WIDTH - 120,
    y: GAME_HEIGHT / 2,
    hp: MAX_HP,
    angle: playerId === 'p1' ? 0 : Math.PI
  };
  lastBulletTime[playerId] = 0;

  socket.emit('assignId', playerId);
  io.emit('stateUpdate', gameState);

  if (Object.keys(gameState.players).length === 2) {
    gameState.phase = 'playing';
    io.emit('stateUpdate', gameState);
  }

  socket.on('input', (input) => {
    const p = gameState.players[playerId];
    if (!p || gameState.phase !== 'playing') return;

    if (input.up)    p.y = Math.max(PLAYER_RADIUS, p.y - PLAYER_SPEED);
    if (input.down)  p.y = Math.min(GAME_HEIGHT - PLAYER_RADIUS, p.y + PLAYER_SPEED);
    if (input.left)  p.x = Math.max(PLAYER_RADIUS, p.x - PLAYER_SPEED);
    if (input.right) p.x = Math.min(GAME_WIDTH - PLAYER_RADIUS, p.x + PLAYER_SPEED);

    const other = gameState.players[playerId === 'p1' ? 'p2' : 'p1'];
    if (other) {
      p.angle = Math.atan2(other.y - p.y, other.x - p.x);
    }

    const now = Date.now();
    if (input.shoot && now - (lastBulletTime[playerId] || 0) > BULLET_COOLDOWN) {
      lastBulletTime[playerId] = now;
      gameState.bullets.push({
        id: now + playerId,
        owner: playerId,
        x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 6),
        y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 6),
        vx: Math.cos(p.angle) * BULLET_SPEED,
        vy: Math.sin(p.angle) * BULLET_SPEED
      });
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[playerId];
    delete lastBulletTime[playerId];
    gameState.bullets = [];
    gameState.phase = 'waiting';
    io.emit('stateUpdate', gameState);
  });
});

function gameTick() {
  if (gameState.phase !== 'playing') return;

  gameState.bullets = gameState.bullets.filter(b => {
    b.x += b.vx;
    b.y += b.vy;
    if (b.x < 0 || b.x > GAME_WIDTH || b.y < 0 || b.y > GAME_HEIGHT) return false;

    for (const [pid, p] of Object.entries(gameState.players)) {
      if (pid === b.owner) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + BULLET_RADIUS) {
        p.hp -= 1;
        if (p.hp <= 0) {
          const winner = b.owner;
          gameState.scores[winner]++;
          gameState.phase = 'roundOver';
          io.emit('roundOver', { winner, scores: gameState.scores });
          setTimeout(() => {
            resetPositions();
            io.emit('stateUpdate', gameState);
          }, 2000);
        }
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
