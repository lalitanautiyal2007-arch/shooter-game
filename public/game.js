const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

let myId = null;
let state = { players:{}, bullets:[], grenades:[], powerups:[], scores:{p1:0,p2:0}, phase:'waiting', obstacles:[], killFeed:[], hazardZones:[], roundNum:1 };
const keys = {};
let particles = [];
let screenShake = { mag:0, dur:0, start:0 };
let mousePos = { x: W/2, y: H/2 };
let mouseDown = false;
const MAX_HP = 5, MAX_LIVES = 3;
const isMobile = 'ontouchstart' in window;

let myAmmo = { pistol: Infinity, shotgun: 0, sniper: 0, smg: 0, rocket: 0 };
let chatInput = '';
let chatVisible = false;
let chatMessages = [];
let statsScreen = null;
let statsTimer = 0;

// Web Audio context for sound effects
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, dur, type='square', vol=0.08, detune=0) {
  try {
    const a = getAudio();
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.connect(gain); gain.connect(a.destination);
    osc.type = type; osc.frequency.value = freq; osc.detune.value = detune;
    gain.gain.setValueAtTime(vol, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    osc.start(a.currentTime); osc.stop(a.currentTime + dur);
  } catch(e) {}
}
function sfxShoot(weapon) {
  if (weapon==='sniper') playTone(180, 0.12, 'sawtooth', 0.12);
  else if (weapon==='shotgun') { playTone(120, 0.18, 'square', 0.15); playTone(80, 0.15, 'sawtooth', 0.1, 200); }
  else if (weapon==='smg') playTone(400, 0.04, 'square', 0.05);
  else if (weapon==='rocket') playTone(80, 0.3, 'sawtooth', 0.18);
  else playTone(300, 0.07, 'square', 0.07);
}
function sfxHit()      { playTone(220, 0.1, 'square', 0.1); }
function sfxDeath()    { playTone(110, 0.4, 'sawtooth', 0.18); playTone(55, 0.6, 'sawtooth', 0.12, -300); }
function sfxExplode()  { playTone(80, 0.5, 'sawtooth', 0.2); playTone(40, 0.4, 'square', 0.15, -500); }
function sfxDash()     { playTone(600, 0.12, 'sine', 0.1); }
function sfxPickup()   { playTone(880, 0.1, 'sine', 0.08); playTone(1200, 0.1, 'sine', 0.06); }
function sfxWin()      { [523,659,784,1047].forEach((f,i) => setTimeout(()=>playTone(f,0.25,'sine',0.12), i*120)); }

const COLORS = {
  p1: { body:'#4fc3f7', dark:'#0277bd', glow:'#4fc3f766' },
  p2: { body:'#ef9a9a', dark:'#c62828', glow:'#ef9a9a66' }
};
const POWERUP_COLORS = {
  speed:'#69f0ae', shield:'#40c4ff', rapidfire:'#ff6e40',
  weapon_shotgun:'#ffca28', weapon_sniper:'#ce93d8', weapon_smg:'#a5d6a7', weapon_rocket:'#ff7043',
  healthpack:'#f48fb1', invincible:'#e040fb', tripleshot:'#ffeb3b'
};
const POWERUP_LABELS = {
  speed:'SPD', shield:'SHD', rapidfire:'RFR',
  weapon_shotgun:'SHG', weapon_sniper:'SNP', weapon_smg:'SMG', weapon_rocket:'RKT',
  healthpack:'HP+', invincible:'INV', tripleshot:'3X'
};
const WEAPON_COLORS = {
  pistol:'#81d4fa', shotgun:'#ffca28', sniper:'#ce93d8', smg:'#a5d6a7', rocket:'#ff7043'
};

// ── Joystick state (mobile) ──────────────────────────────────
const joystick = { active:false, startX:0, startY:0, dx:0, dy:0, id:null };
let mobileShoot = false, mobileGrenade = false, mobileDash = false;

// ── Socket events ────────────────────────────────────────────
socket.on('assignId', id => {
  myId = id;
  document.getElementById('youLabel').textContent = id === 'p1' ? 'YOU = P1 🔵 BLUE' : 'YOU = P2 🔴 RED';
});

socket.on('stateUpdate', s => {
  state = s;
  if (s._ammo && myId) myAmmo = s._ammo[myId] || myAmmo;
  updateHUD();
});

socket.on('obstacles', obs => state.obstacles = obs);

socket.on('botJoined', () => {
  showToast('🤖 AI opponent joined!', '#69f0ae');
});

socket.on('ammoUpdate', ({ pid, ammo }) => {
  if (pid === myId) myAmmo = ammo;
});

socket.on('ammoEmpty', ({ pid, weapon }) => {
  if (pid === myId) showToast(`Out of ${weapon.toUpperCase()} ammo!`, '#ff7043');
});

socket.on('hitEffect', ({ x, y, type }) => {
  if (type === 'death')  { spawnParticles(x, y, '#ff5252', 30); triggerShake(14, 350); sfxDeath(); }
  else if (type === 'hit')    { spawnParticles(x, y, '#ff8a65', 14); triggerShake(5, 150); sfxHit(); }
  else if (type === 'shield') { spawnParticles(x, y, '#40c4ff', 12); }
  else if (type === 'wall')   { spawnParticles(x, y, '#90a4ae', 6); }
});

socket.on('explosion', ({ x, y, r }) => {
  spawnParticles(x, y, '#ff6d00', 45);
  spawnParticles(x, y, '#ffea00', 25);
  spawnParticles(x, y, '#fff', 10);
  triggerShake(20, 550);
  particles.push({ ring: true, x, y, r: 10, maxR: r, life: 1, decay: 0.04 });
  sfxExplode();
});

socket.on('dashEffect', ({ id, x, y }) => {
  const c = COLORS[id] || COLORS.p1;
  spawnParticles(x, y, c.body, 14);
  sfxDash();
});

socket.on('respawnEffect', ({ id }) => {
  const p = state.players[id];
  if (p) spawnParticles(p.x, p.y, '#69f0ae', 20);
  if (id === myId) showToast('Respawned!', '#69f0ae');
});

socket.on('powerupCollected', ({ pid, type, x, y }) => {
  spawnParticles(x, y, POWERUP_COLORS[type] || '#fff', 16);
  if (pid === myId) { sfxPickup(); showToast('+' + (POWERUP_LABELS[type]||type), POWERUP_COLORS[type]||'#fff'); }
});

socket.on('playerDied', ({ id, lives }) => {
  if (state.players[id]) state.players[id].lives = lives;
  updateHUD();
});

socket.on('matchOver', (data) => {
  state.scores = data.scores;
  state.killFeed = data.killFeed || [];
  updateHUD();
  const isWinner = data.winner === myId;
  statsScreen = data;
  statsTimer = 220;
  if (isWinner) sfxWin();
  triggerShake(22, 700);
});

socket.on('chatMessage', (entry) => {
  chatMessages.unshift(entry);
  if (chatMessages.length > 6) chatMessages.pop();
});

socket.on('full', () => {
  showToast('Game full — spectating', '#ff5252');
});

// ── Toast notifications ──────────────────────────────────────
let toasts = [];
function showToast(msg, color='#fff', dur=2000) {
  toasts.push({ msg, color, life: 1, x: W/2, y: H/2 - 60, vy: -0.8, dur });
  setTimeout(() => toasts.shift(), dur);
}

function updateHUD() {
  const s = state;
  document.getElementById('p1score').textContent = `P1 ${s.scores?.p1||0}`;
  document.getElementById('p2score').textContent = `P2 ${s.scores?.p2||0}`;
  const p1=s.players?.p1, p2=s.players?.p2;
  const l1=document.getElementById('lives-p1'), l2=document.getElementById('lives-p2');
  if (l1&&p1) l1.innerHTML = Array.from({length:MAX_LIVES},(_,i)=>`<span style="opacity:${i<p1.lives?1:0.18}">♥</span>`).join('');
  if (l2&&p2) l2.innerHTML = Array.from({length:MAX_LIVES},(_,i)=>`<span style="opacity:${i<p2.lives?1:0.18}">♥</span>`).join('');
  if (s.phase==='waiting') document.getElementById('status').textContent='Waiting for players...';
  const rnd = document.getElementById('roundNum');
  if (rnd) rnd.textContent = `Round ${s.roundNum||1}`;
}

// ── Particles ────────────────────────────────────────────────
function spawnParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 1.5 + Math.random() * 5;
    particles.push({ x, y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd, life:1, decay:0.022+Math.random()*0.04, r:2+Math.random()*3.5, color });
  }
}

function triggerShake(mag, dur) {
  screenShake = { mag, dur, start: Date.now() };
}

// ── Draw ─────────────────────────────────────────────────────
function drawArena() {
  // Dark gradient background
  const grad = ctx.createRadialGradient(W/2,H/2,50, W/2,H/2,400);
  grad.addColorStop(0,'#0d1020');
  grad.addColorStop(1,'#060810');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,W,H);

  // Grid lines
  ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 1;
  for (let x=0; x<W; x+=50) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0; y<H; y+=50) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Center divider
  ctx.setLineDash([8,8]); ctx.strokeStyle='#ffffff0a'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.setLineDash([]);

  // Arena border glow
  ctx.strokeStyle='#4fc3f722'; ctx.lineWidth=3;
  ctx.strokeRect(2,2,W-4,H-4);
}

function drawHazardZones() {
  for (const hz of (state.hazardZones||[])) {
    const t = Date.now()/1000;
    const pulse = 0.5 + 0.5*Math.sin(t*3 + hz.id);
    const alpha = 0.15 + 0.1*pulse;
    const r = hz.r * (0.95 + 0.05*pulse);
    const grd = ctx.createRadialGradient(hz.x, hz.y, 0, hz.x, hz.y, r);
    grd.addColorStop(0, `rgba(255,60,0,${alpha+0.1})`);
    grd.addColorStop(0.6, `rgba(255,100,0,${alpha})`);
    grd.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.beginPath(); ctx.arc(hz.x, hz.y, r, 0, Math.PI*2);
    ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath(); ctx.arc(hz.x, hz.y, r, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(255,120,0,${0.3+0.2*pulse})`; ctx.lineWidth = 2; ctx.stroke();
    // Warning text
    ctx.fillStyle = `rgba(255,180,0,${0.6+0.3*pulse})`;
    ctx.font = 'bold 11px Courier New'; ctx.textAlign='center';
    ctx.fillText('⚠ HAZARD', hz.x, hz.y+4);
  }
}

function drawObstacles() {
  for (const o of (state.obstacles||[])) {
    // Shadow
    ctx.fillStyle='#00000088';
    ctx.fillRect(o.x+3,o.y+3,o.w,o.h);
    // Body with gradient
    const grd = ctx.createLinearGradient(o.x,o.y,o.x,o.y+o.h);
    grd.addColorStop(0,'#253045');
    grd.addColorStop(1,'#1a2030');
    ctx.fillStyle=grd; ctx.fillRect(o.x,o.y,o.w,o.h);
    ctx.strokeStyle='#4a6080'; ctx.lineWidth=1.5; ctx.strokeRect(o.x,o.y,o.w,o.h);
    // Highlight top edge
    ctx.fillStyle='#ffffff18'; ctx.fillRect(o.x,o.y,o.w,3);
    // Inner pattern
    ctx.fillStyle='#ffffff06';
    for (let ix=o.x+6;ix<o.x+o.w-4;ix+=10) ctx.fillRect(ix,o.y+4,4,o.h-8);
  }
}

function drawPowerups() {
  const now = Date.now();
  for (const pu of (state.powerups||[])) {
    const pulse = 0.82 + 0.18*Math.sin(now/280);
    const rot = now/1200;
    const col = POWERUP_COLORS[pu.type]||'#fff';
    ctx.save(); ctx.translate(pu.x,pu.y); ctx.scale(pulse,pulse);
    // Glow
    const grd = ctx.createRadialGradient(0,0,0,0,0,22);
    grd.addColorStop(0,col+'55'); grd.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(0,0,22,0,Math.PI*2); ctx.fillStyle=grd; ctx.fill();
    // Rotating outer ring
    ctx.rotate(rot);
    ctx.beginPath();
    for (let i=0;i<6;i++) {
      const a=i/6*Math.PI*2, a2=(i+0.4)/6*Math.PI*2;
      ctx.arc(0,0,16,a,a2);
    }
    ctx.strokeStyle=col; ctx.lineWidth=2.5; ctx.stroke();
    ctx.rotate(-rot);
    // Inner circle
    ctx.beginPath(); ctx.arc(0,0,10,0,Math.PI*2);
    ctx.fillStyle=col+'44'; ctx.fill();
    ctx.strokeStyle=col+'cc'; ctx.lineWidth=1.5; ctx.stroke();
    // Label
    ctx.fillStyle=col; ctx.font='bold 8px Courier New';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(POWERUP_LABELS[pu.type]||'?',0,0);
    ctx.restore();
  }
}

function drawPlayer(p) {
  const PLAYER_RADIUS = 18;
  if (p.dead) {
    ctx.save(); ctx.globalAlpha=0.22;
    ctx.beginPath(); ctx.arc(p.x,p.y,PLAYER_RADIUS,0,Math.PI*2);
    ctx.fillStyle=COLORS[p.id]?.dark||'#333'; ctx.fill();
    ctx.restore();
    const sec=Math.ceil((p.respawnTimer||0)/60);
    ctx.fillStyle='#ffffff99'; ctx.font='bold 14px Courier New';
    ctx.textAlign='center'; ctx.fillText(sec+'s',p.x,p.y+4);
    ctx.font='10px Courier New'; ctx.fillStyle='#ffffff55';
    ctx.fillText('RESPAWNING',p.x,p.y+20);
    return;
  }
  const c=COLORS[p.id]||COLORS.p1;
  const r=18;
  ctx.save(); ctx.translate(p.x,p.y);

  // Invincible effect
  if (p.invincible) {
    const t=Date.now()/300;
    const rainbow=`hsl(${(t*60)%360},100%,60%)`;
    ctx.beginPath(); ctx.arc(0,0,r+12,0,Math.PI*2);
    ctx.strokeStyle=rainbow+'bb'; ctx.lineWidth=4; ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,r+8,0,Math.PI*2);
    ctx.strokeStyle=rainbow+'44'; ctx.lineWidth=6; ctx.stroke();
  }
  if (p.shield) {
    ctx.beginPath(); ctx.arc(0,0,r+10,0,Math.PI*2);
    ctx.strokeStyle='#40c4ffaa'; ctx.lineWidth=3; ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,r+10,0,Math.PI*2);
    ctx.fillStyle='#40c4ff11'; ctx.fill();
  }
  if (p.rapidfire) {
    ctx.beginPath(); ctx.arc(0,0,r+6,0,Math.PI*2);
    ctx.fillStyle='#ff6e4022'; ctx.fill();
  }
  if ((p.speed||4)>4) {
    const t=Date.now()/500;
    ctx.save(); ctx.rotate(-p.angle);
    for (let i=0;i<3;i++) {
      ctx.beginPath();
      ctx.arc(-r-8-i*6, 0, 3-i, 0, Math.PI*2);
      ctx.fillStyle=`rgba(105,240,174,${0.5-i*0.15})`; ctx.fill();
    }
    ctx.restore();
  }
  if (p.tripleshot) {
    ctx.beginPath(); ctx.arc(0,0,r+6,0,Math.PI*2);
    ctx.fillStyle='#ffeb3b22'; ctx.fill();
  }

  // Body shadow
  ctx.beginPath(); ctx.arc(2,3,r,0,Math.PI*2);
  ctx.fillStyle='#00000066'; ctx.fill();

  // Body
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
  const bGrad=ctx.createRadialGradient(-4,-4,2,0,0,r);
  bGrad.addColorStop(0,c.body); bGrad.addColorStop(1,c.dark);
  ctx.fillStyle=bGrad; ctx.fill();
  ctx.strokeStyle=c.body; ctx.lineWidth=2.5; ctx.stroke();

  // Gun barrel
  ctx.rotate(p.angle);
  const wc=WEAPON_COLORS[p.weapon]||c.body;
  const gl=p.weapon==='sniper'?26:p.weapon==='shotgun'?14:p.weapon==='rocket'?18:p.weapon==='smg'?16:14;
  const gh=p.weapon==='shotgun'?10:p.weapon==='rocket'?8:7;
  // Barrel shadow
  ctx.fillStyle='#00000066'; ctx.fillRect(r-1,-(gh/2)+2,gl,gh);
  ctx.fillStyle=wc; ctx.fillRect(r-2,-gh/2,gl,gh);
  // Barrel highlight
  ctx.fillStyle='#ffffff33'; ctx.fillRect(r-2,-gh/2,gl,2);
  // Muzzle tip
  ctx.fillStyle=wc; ctx.beginPath(); ctx.arc(r+gl-2,0,gh/2,0,Math.PI*2); ctx.fill();

  ctx.restore();

  // HP pips
  for (let i=0;i<MAX_HP;i++) {
    const bx=p.x-(MAX_HP*10)/2+i*10+4, by=p.y-r-14;
    ctx.beginPath(); ctx.arc(bx,by,4,0,Math.PI*2);
    ctx.fillStyle=i<p.hp?c.body:'#1a1a2e'; ctx.fill();
    ctx.strokeStyle=i<p.hp?c.body+'88':'#333'; ctx.lineWidth=1; ctx.stroke();
  }

  // Name tag
  const isMe = p.id===myId;
  const tag=p.id.toUpperCase()+(p.weapon!=='pistol'?` [${p.weapon.slice(0,3).toUpperCase()}]`:'')+( p.isBot?' 🤖':isMe?' ◀':'');
  ctx.fillStyle=isMe?c.body:'#ffffffaa'; ctx.font=`bold ${isMe?11:10}px Courier New`;
  ctx.textAlign='center'; ctx.fillText(tag,p.x,p.y+r+16);
}

function drawBullets() {
  for (const b of state.bullets) {
    const r=b.weapon==='sniper'?4:b.weapon==='shotgun'?3:b.weapon==='rocket'?7:5;
    // Glow
    ctx.beginPath(); ctx.arc(b.x,b.y,r+6,0,Math.PI*2);
    ctx.fillStyle=(b.color||'#fff')+'22'; ctx.fill();
    // Core
    ctx.beginPath(); ctx.arc(b.x,b.y,r,0,Math.PI*2);
    ctx.fillStyle=b.color||'#fff'; ctx.fill();
    // Rocket has flame trail
    if (b.weapon==='rocket') {
      ctx.beginPath(); ctx.arc(b.x-b.vx*2,b.y-b.vy*2,4,0,Math.PI*2);
      ctx.fillStyle='#ff600088'; ctx.fill();
      ctx.beginPath(); ctx.arc(b.x-b.vx*4,b.y-b.vy*4,2,0,Math.PI*2);
      ctx.fillStyle='#ffea0044'; ctx.fill();
    }
  }
}

function drawGrenades() {
  for (const g of (state.grenades||[])) {
    const pulse=0.7+0.3*Math.sin(Date.now()/80);
    // Shadow
    ctx.beginPath(); ctx.arc(g.x+2,g.y+2,8,0,Math.PI*2);
    ctx.fillStyle='#00000055'; ctx.fill();
    // Body
    ctx.beginPath(); ctx.arc(g.x,g.y,8,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,${Math.floor(80+pulse*120)},0,0.95)`; ctx.fill();
    ctx.strokeStyle='#fff8'; ctx.lineWidth=1.5; ctx.stroke();
    // Fuse ring
    const fusePct=(g.fuse||0)/120;
    ctx.beginPath(); ctx.arc(g.x,g.y,12,-Math.PI/2,-Math.PI/2+fusePct*Math.PI*2);
    ctx.strokeStyle='#ffea00'; ctx.lineWidth=2.5; ctx.stroke();
  }
}

function drawParticles() {
  for (let i=particles.length-1;i>=0;i--) {
    const p=particles[i];
    if (p.ring) {
      p.r+=(p.maxR-p.r)*0.14;
      p.life-=p.decay;
      if (p.life<=0){particles.splice(i,1);continue;}
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.strokeStyle=`rgba(255,109,0,${p.life*0.8})`; ctx.lineWidth=3; ctx.stroke();
      // Second ring
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r*0.6,0,Math.PI*2);
      ctx.strokeStyle=`rgba(255,220,0,${p.life*0.5})`; ctx.lineWidth=1.5; ctx.stroke();
      continue;
    }
    p.x+=p.vx; p.y+=p.vy; p.vx*=0.91; p.vy*=0.91; p.life-=p.decay;
    if (p.life<=0){particles.splice(i,1);continue;}
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);
    ctx.fillStyle=p.color+Math.floor(p.life*255).toString(16).padStart(2,'0');
    ctx.fill();
  }
}

function drawKillFeed() {
  const entries=state.killFeed||[];
  if (!entries.length) return;
  entries.slice(0,5).forEach((e,i)=>{
    const alpha=0.9-i*0.15;
    const killerC=COLORS[e.killer]?.body||'#fff';
    const victimC=COLORS[e.victim]?.body||'#fff';
    const kName=e.killer.toUpperCase();
    const vName=e.victim.toUpperCase();
    const wName=(e.weapon||'pistol').toUpperCase();
    const text=`${kName} ❯ ${vName} [${wName}]`;
    ctx.font='11px Courier New';
    const tw=ctx.measureText(text).width;
    // Background
    ctx.fillStyle=`rgba(0,0,0,${alpha*0.55})`;
    ctx.fillRect(W-tw-20,8+i*22,tw+14,18);
    ctx.strokeStyle=`rgba(255,255,255,${alpha*0.15})`;
    ctx.lineWidth=1; ctx.strokeRect(W-tw-20,8+i*22,tw+14,18);
    // Text with colored names
    ctx.fillStyle=`rgba(255,255,255,${alpha})`;
    ctx.textAlign='right'; ctx.fillText(text,W-10,21+i*22);
  });
}

function drawCooldowns() {
  const p=myId&&state.players[myId];
  if (!p||p.dead) return;
  const now=Date.now();
  const items=[
    {label:'GRENADE',last:window._lastGrenade||0,cd:2000,color:'#ffea00'},
    {label:'DASH',   last:window._lastDash||0,   cd:1200,color:'#69f0ae'},
  ];
  items.forEach((item,i)=>{
    const elapsed=now-item.last;
    const pct=Math.min(elapsed/item.cd,1);
    const bx=10,by=H-50+i*24;
    ctx.fillStyle='#00000066'; ctx.fillRect(bx,by,120,16);
    ctx.fillStyle=pct>=1?item.color:item.color+'44';
    ctx.fillRect(bx,by,120*pct,16);
    ctx.fillStyle='#fff'; ctx.font='9px Courier New'; ctx.textAlign='left';
    ctx.fillText(item.label+(pct>=1?' READY':''),bx+4,by+11);
  });
}

function drawAmmoHUD() {
  const p=myId&&state.players[myId];
  if (!p||p.dead) return;
  const wx=W-10, wy=H-55;
  const wep=p.weapon||'pistol';
  const ammoVal=myAmmo[wep];
  const ammoStr=ammoVal===Infinity?'∞':String(ammoVal||0);
  const wColor=WEAPON_COLORS[wep]||'#fff';
  ctx.fillStyle='#00000077'; ctx.fillRect(wx-140,wy-18,140,42);
  ctx.fillStyle=wColor; ctx.font='bold 13px Courier New'; ctx.textAlign='right';
  ctx.fillText(wep.toUpperCase(),wx,wy);
  ctx.fillStyle='#fff'; ctx.font='bold 20px Courier New';
  ctx.fillText(ammoStr,wx,wy+20);
  // Weapon switch hints
  ctx.fillStyle='#ffffff44'; ctx.font='8px Courier New';
  ctx.fillText('1-5: switch',wx,wy+34);
}

function drawMinimap() {
  const mx=W-90, my=H-90, mw=80, mh=60;
  ctx.fillStyle='#00000055'; ctx.fillRect(mx,my,mw,mh);
  ctx.strokeStyle='#ffffff22'; ctx.lineWidth=1; ctx.strokeRect(mx,my,mw,mh);
  // Obstacles
  for (const o of (state.obstacles||[])) {
    ctx.fillStyle='#4a6080aa';
    ctx.fillRect(mx+o.x/W*mw, my+o.y/H*mh, o.w/W*mw, o.h/H*mh);
  }
  // Players
  for (const [pid,p] of Object.entries(state.players)) {
    if (p.dead) continue;
    ctx.beginPath();
    ctx.arc(mx+p.x/W*mw, my+p.y/H*mh, 3, 0, Math.PI*2);
    ctx.fillStyle=COLORS[pid]?.body||'#fff'; ctx.fill();
    if (pid===myId) { ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke(); }
  }
  ctx.fillStyle='#ffffff44'; ctx.font='7px Courier New'; ctx.textAlign='left';
  ctx.fillText('MAP',mx+2,my+mh-2);
}

function drawChat() {
  const msgs=chatMessages.slice(0,5);
  if (!msgs.length&&!chatVisible) return;
  const cx=10, cy=H-120;
  msgs.forEach((m,i)=>{
    const alpha=1-i*0.18;
    const text=`${m.pid.toUpperCase()}: ${m.text}`;
    ctx.font='10px Courier New';
    const tw=ctx.measureText(text).width;
    ctx.fillStyle=`rgba(0,0,0,${alpha*0.5})`;
    ctx.fillRect(cx,cy-i*16,tw+10,14);
    ctx.fillStyle=`rgba(255,255,255,${alpha})`;
    ctx.textAlign='left'; ctx.fillText(text,cx+4,cy+10-i*16);
  });
  if (chatVisible) {
    ctx.fillStyle='#00000088'; ctx.fillRect(cx,cy-msgs.length*16-20,250,18);
    ctx.fillStyle='#69f0ae'; ctx.font='10px Courier New'; ctx.textAlign='left';
    ctx.fillText('> '+chatInput+'_',cx+4,cy-msgs.length*16-6);
  }
}

function drawToasts() {
  toasts.forEach((t,i)=>{
    ctx.fillStyle=t.color||'#fff';
    ctx.font='bold 16px Courier New';
    ctx.textAlign='center';
    ctx.globalAlpha=0.9;
    ctx.fillText(t.msg, t.x, t.y-i*24);
    ctx.globalAlpha=1;
  });
}

function drawStatsScreen(data) {
  if (!data||statsTimer<=0) return;
  statsTimer--;
  const alpha=Math.min(1,(220-statsTimer)/15)*Math.min(1,statsTimer/15);
  const bx=W/2-200, by=H/2-160, bw=400, bh=320;
  ctx.fillStyle=`rgba(5,8,20,${alpha*0.92})`; ctx.fillRect(bx,by,bw,bh);
  ctx.strokeStyle=`rgba(100,180,255,${alpha*0.5})`; ctx.lineWidth=2; ctx.strokeRect(bx,by,bw,bh);

  const isWinner=data.winner===myId;
  ctx.fillStyle=isWinner?`rgba(105,240,174,${alpha})`:`rgba(255,82,82,${alpha})`;
  ctx.font=`bold 30px Courier New`; ctx.textAlign='center';
  ctx.fillText(isWinner?'MATCH WIN!':'MATCH OVER', W/2, by+50);

  ctx.fillStyle=`rgba(255,255,255,${alpha*0.7})`; ctx.font='12px Courier New';
  ctx.fillText(`Score: P1 ${data.scores?.p1||0} — P2 ${data.scores?.p2||0}`, W/2, by+80);

  // Stats table
  const stats=data.stats||{};
  ['p1','p2'].forEach((pid,col)=>{
    const s=stats[pid]||{};
    const px=bx+60+col*200, py=by+110;
    const c=COLORS[pid]?.body||'#fff';
    ctx.fillStyle=`rgba(${pid==='p1'?'79,195,247':'239,154,154'},${alpha})`; ctx.font='bold 13px Courier New';
    ctx.textAlign='center';
    ctx.fillText(pid.toUpperCase()+(s.isBot?' (BOT)':'')+(pid===myId?' ◀':''), px+40, py);
    const rows=[
      ['Kills',s.kills||0],['Deaths',s.deaths||0],
      ['Damage',s.damageDealt||0],['Shots',s.shotsFired||0],
      ['KDR',s.deaths?(s.kills/s.deaths).toFixed(1):'∞']
    ];
    rows.forEach(([k,v],i)=>{
      ctx.fillStyle=`rgba(255,255,255,${alpha*0.6})`; ctx.textAlign='left'; ctx.font='10px Courier New';
      ctx.fillText(k, px, py+20+i*22);
      ctx.fillStyle=`rgba(255,255,255,${alpha*0.9})`; ctx.textAlign='right'; ctx.font='bold 10px Courier New';
      ctx.fillText(String(v), px+80, py+20+i*22);
    });
  });
  ctx.fillStyle=`rgba(255,255,255,${alpha*0.35})`; ctx.font='10px Courier New'; ctx.textAlign='center';
  ctx.fillText('Next round starting...', W/2, by+bh-20);
}

function drawWaiting() {
  ctx.fillStyle='#ffffff18'; ctx.font='bold 26px Courier New'; ctx.textAlign='center';
  ctx.fillText('WAITING FOR PLAYERS', W/2, H/2-10);
  ctx.font='13px Courier New'; ctx.fillStyle='#ffffff44';
  ctx.fillText('Open in two tabs / devices to play', W/2, H/2+28);
}

// ── Input ─────────────────────────────────────────────────────
canvas.addEventListener('mousemove', e => {
  const r=canvas.getBoundingClientRect();
  mousePos.x=(e.clientX-r.left)*(W/r.width);
  mousePos.y=(e.clientY-r.top)*(H/r.height);
});
canvas.addEventListener('mousedown', e => {
  if (e.button===0) { mouseDown=true; getAudio(); } // unlock audio
});
canvas.addEventListener('mouseup', e => { if(e.button===0) mouseDown=false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

// Chat input
document.addEventListener('keydown', e => {
  if (chatVisible) {
    if (e.key==='Escape') { chatVisible=false; chatInput=''; return; }
    if (e.key==='Enter') {
      if (chatInput.trim()) socket.emit('chat', chatInput.trim());
      chatVisible=false; chatInput=''; return;
    }
    if (e.key==='Backspace') { chatInput=chatInput.slice(0,-1); return; }
    if (e.key.length===1) { chatInput+=e.key; return; }
    return;
  }
  if (e.key==='t'||e.key==='T') { chatVisible=true; e.preventDefault(); return; }
  keys[e.key.toLowerCase()]=true; keys[e.key]=true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});
document.addEventListener('keyup', e => { keys[e.key.toLowerCase()]=false; keys[e.key]=false; });

// Weapon switch via number keys
function checkWeaponSwitch() {
  const wMap={ '1':'pistol','2':'shotgun','3':'sniper','4':'smg','5':'rocket' };
  for (const [k,w] of Object.entries(wMap)) {
    if (keys[k]) return w;
  }
  return null;
}

function getAimAngle() {
  const p=myId&&state.players[myId];
  if (!p) return 0;
  return Math.atan2(mousePos.y-p.y, mousePos.x-p.x);
}

function sendInput() {
  if (state.phase!=='playing'||!myId) return;
  const isP1=myId==='p1';
  const now=Date.now();
  let shoot, grenade, dash;

  if (isMobile) {
    shoot=mobileShoot; grenade=mobileGrenade; dash=mobileDash;
  } else {
    // Both players use left mouse button to shoot
    shoot = mouseDown;
    grenade = isP1?keys['g']:keys['p'];
    dash = keys['shift']||keys['Shift'];
  }

  if (grenade) window._lastGrenade=now;
  if (dash)    window._lastDash=now;

  const switchWeapon=checkWeaponSwitch();

  socket.emit('input', {
    up:    isP1?(keys['w']||keys['arrowup'])   :keys['ArrowUp'],
    down:  isP1?(keys['s']||keys['arrowdown']) :keys['ArrowDown'],
    left:  isP1?(keys['a']||keys['arrowleft']) :keys['ArrowLeft'],
    right: isP1?(keys['d']||keys['arrowright']):keys['ArrowRight'],
    shoot, grenade, dash,
    aimAngle: getAimAngle(),
    switchWeapon
  });
}

// ── Mobile controls ──────────────────────────────────────────
function setupMobileControls() {
  const ui=document.getElementById('mobile-ui');
  if (!isMobile) return;
  ui.style.display='flex';
  const stick=document.getElementById('joystick-base');
  const knob=document.getElementById('joystick-knob');

  stick.addEventListener('touchstart', e=>{
    const t=e.touches[0], r=stick.getBoundingClientRect();
    joystick.active=true; joystick.startX=r.left+r.width/2; joystick.startY=r.top+r.height/2; joystick.id=t.identifier;
    e.preventDefault();
  },{passive:false});

  stick.addEventListener('touchmove', e=>{
    for (const t of e.touches) {
      if (t.identifier!==joystick.id) continue;
      const dx=t.clientX-joystick.startX, dy=t.clientY-joystick.startY;
      const dist=Math.min(Math.sqrt(dx*dx+dy*dy),40), ang=Math.atan2(dy,dx);
      joystick.dx=Math.cos(ang)*dist/40; joystick.dy=Math.sin(ang)*dist/40;
      knob.style.transform=`translate(${Math.cos(ang)*dist}px,${Math.sin(ang)*dist}px)`;
    }
    e.preventDefault();
  },{passive:false});

  stick.addEventListener('touchend',()=>{joystick.active=false;joystick.dx=0;joystick.dy=0;knob.style.transform='translate(0,0)';});

  document.getElementById('shoot-btn').addEventListener('touchstart',e=>{mobileShoot=true;e.preventDefault();},{passive:false});
  document.getElementById('shoot-btn').addEventListener('touchend',()=>mobileShoot=false);
  document.getElementById('grenade-btn').addEventListener('touchstart',e=>{mobileGrenade=true;e.preventDefault();},{passive:false});
  document.getElementById('grenade-btn').addEventListener('touchend',()=>mobileGrenade=false);
  document.getElementById('dash-btn').addEventListener('touchstart',e=>{mobileDash=true;e.preventDefault();},{passive:false});
  document.getElementById('dash-btn').addEventListener('touchend',()=>mobileDash=false);
}

// ── Render loop ──────────────────────────────────────────────
function render() {
  const now=Date.now();
  let sx=0,sy=0;
  if (screenShake.dur>0) {
    const prog=(now-screenShake.start)/screenShake.dur;
    if (prog<1){const m=screenShake.mag*(1-prog);sx=(Math.random()-.5)*m;sy=(Math.random()-.5)*m;}
  }
  ctx.save(); ctx.translate(sx,sy);
  drawArena();
  drawHazardZones();
  drawObstacles();
  drawPowerups();
  if (state.phase==='waiting') drawWaiting();
  for (const p of Object.values(state.players)) drawPlayer(p);
  drawBullets();
  drawGrenades();
  drawParticles();
  drawKillFeed();
  drawCooldowns();
  drawAmmoHUD();
  drawMinimap();
  drawChat();
  drawToasts();
  if (statsScreen&&statsTimer>0) drawStatsScreen(statsScreen);
  ctx.restore();
  requestAnimationFrame(render);
}

setInterval(sendInput, 1000/60);
setupMobileControls();
render();
