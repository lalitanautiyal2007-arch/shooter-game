const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ── Canvas matches server dimensions exactly — CSS scales to fill screen ─
const W = 800, H = 560;
canvas.width = W;
canvas.height = H;

let myId = null;
let state = { players:{}, bullets:[], grenades:[], powerups:[], scores:{p1:0,p2:0}, phase:'waiting', obstacles:[], killFeed:[], hazardZones:[], roundNum:1 };

const keys = {};
const prevKeyState = {};     // edge-detection for weapon switch
let pendingWeaponSwitch = null;

let particles = [];
let screenShake = { mag:0, dur:0, start:0 };
let mousePos = { x:W/2, y:H/2 };
let mouseDown = false;

const MAX_HP = 5, MAX_LIVES = 3;
const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

let myAmmo = { pistol: Infinity, shotgun:0, sniper:0, smg:0, rocket:0 };
let chatInput='', chatVisible=false, chatMessages=[];
let statsScreen=null, statsTimer=0;
let toasts=[];

// Auto-aim
let autoAimTarget = null;
let autoAimAngle  = 0;

// Mobile joystick
const joystick = { active:false, startX:0, startY:0, dx:0, dy:0, id:null };
let mobileShoot=false, mobileGrenade=false, mobileDash=false;

// ── Audio ─────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq,dur,type='square',vol=0.08,detune=0) {
  try {
    const a=getAudio(), osc=a.createOscillator(), gain=a.createGain();
    osc.connect(gain); gain.connect(a.destination);
    osc.type=type; osc.frequency.value=freq; osc.detune.value=detune;
    gain.gain.setValueAtTime(vol,a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,a.currentTime+dur);
    osc.start(a.currentTime); osc.stop(a.currentTime+dur);
  } catch(e){}
}
const sfxShoot=w=>{
  if(w==='sniper')playTone(180,0.12,'sawtooth',0.12);
  else if(w==='shotgun'){playTone(120,0.18,'square',0.15);playTone(80,0.15,'sawtooth',0.1,200);}
  else if(w==='smg')playTone(400,0.04,'square',0.05);
  else if(w==='rocket')playTone(80,0.3,'sawtooth',0.18);
  else playTone(300,0.07,'square',0.07);
};
const sfxHit=    ()=>playTone(220,0.1,'square',0.1);
const sfxDeath=  ()=>{playTone(110,0.4,'sawtooth',0.18);playTone(55,0.6,'sawtooth',0.12,-300);};
const sfxExplode=()=>{playTone(80,0.5,'sawtooth',0.2);playTone(40,0.4,'square',0.15,-500);};
const sfxDash=   ()=>playTone(600,0.12,'sine',0.1);
const sfxPickup= ()=>{playTone(880,0.1,'sine',0.08);playTone(1200,0.1,'sine',0.06);};
const sfxWin=    ()=>[523,659,784,1047].forEach((f,i)=>setTimeout(()=>playTone(f,0.25,'sine',0.12),i*120));

// ── Colors ────────────────────────────────────────────────────
const COLORS={
  p1:{body:'#4fc3f7',dark:'#0277bd',glow:'#4fc3f766'},
  p2:{body:'#ef9a9a',dark:'#c62828',glow:'#ef9a9a66'}
};
const POWERUP_COLORS={
  speed:'#69f0ae',shield:'#40c4ff',rapidfire:'#ff6e40',
  weapon_shotgun:'#ffca28',weapon_sniper:'#ce93d8',weapon_smg:'#a5d6a7',weapon_rocket:'#ff7043',
  healthpack:'#f48fb1',invincible:'#e040fb',tripleshot:'#ffeb3b'
};
const POWERUP_LABELS={
  speed:'SPD',shield:'SHD',rapidfire:'RFR',
  weapon_shotgun:'SHG',weapon_sniper:'SNP',weapon_smg:'SMG',weapon_rocket:'RKT',
  healthpack:'HP+',invincible:'INV',tripleshot:'3X'
};
const WEAPON_COLORS={
  pistol:'#81d4fa',shotgun:'#ffca28',sniper:'#ce93d8',smg:'#a5d6a7',rocket:'#ff7043'
};

// ── Socket events ─────────────────────────────────────────────
socket.on('assignId',id=>{
  myId=id;
  document.getElementById('youLabel').textContent=id==='p1'?'YOU = P1 🔵 BLUE':'YOU = P2 🔴 RED';
});
socket.on('stateUpdate',s=>{state=s;if(s._ammo&&myId)myAmmo=s._ammo[myId]||myAmmo;updateHUD();});
socket.on('obstacles',obs=>state.obstacles=obs);
socket.on('botJoined',()=>showToast('🤖 AI opponent joined!','#69f0ae'));
socket.on('ammoUpdate',({pid,ammo})=>{if(pid===myId)myAmmo=ammo;});
socket.on('ammoEmpty',({pid,weapon})=>{if(pid===myId)showToast(`Out of ${weapon.toUpperCase()} ammo!`,'#ff7043');});
socket.on('hitEffect',({x,y,type})=>{
  if(type==='death'){spawnParticles(x,y,'#ff5252',30);triggerShake(14,350);sfxDeath();}
  else if(type==='hit'){spawnParticles(x,y,'#ff8a65',14);triggerShake(5,150);sfxHit();}
  else if(type==='shield')spawnParticles(x,y,'#40c4ff',12);
  else if(type==='wall')spawnParticles(x,y,'#90a4ae',6);
});
socket.on('explosion',({x,y,r})=>{
  spawnParticles(x,y,'#ff6d00',45);spawnParticles(x,y,'#ffea00',25);spawnParticles(x,y,'#fff',10);
  triggerShake(20,550);
  particles.push({ring:true,x,y,r:10,maxR:r,life:1,decay:0.04});
  sfxExplode();
});
socket.on('dashEffect',({id,x,y})=>{const c=COLORS[id]||COLORS.p1;spawnParticles(x,y,c.body,14);sfxDash();});
socket.on('respawnEffect',({id})=>{
  const p=state.players[id];if(p)spawnParticles(p.x,p.y,'#69f0ae',20);
  if(id===myId)showToast('Respawned!','#69f0ae');
});
socket.on('powerupCollected',({pid,type,x,y})=>{
  spawnParticles(x,y,POWERUP_COLORS[type]||'#fff',16);
  if(pid===myId){sfxPickup();showToast('+'+(POWERUP_LABELS[type]||type),POWERUP_COLORS[type]||'#fff');}
});
socket.on('playerDied',({id,lives})=>{if(state.players[id])state.players[id].lives=lives;updateHUD();});
socket.on('matchOver',data=>{
  state.scores=data.scores;state.killFeed=data.killFeed||[];updateHUD();
  statsScreen=data;statsTimer=220;
  if(data.winner===myId)sfxWin();
  triggerShake(22,700);
});
socket.on('chatMessage',entry=>{chatMessages.unshift(entry);if(chatMessages.length>6)chatMessages.pop();});
socket.on('full',()=>showToast('Game full — spectating','#ff5252'));

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg,color='#fff',dur=2000){
  toasts.push({msg,color,life:1,x:W/2,y:H/2-60,vy:-0.8,dur});
  setTimeout(()=>toasts.shift(),dur);
}

// ── HUD ───────────────────────────────────────────────────────
function updateHUD(){
  const s=state;
  document.getElementById('p1score').textContent=`P1 ${s.scores?.p1||0}`;
  document.getElementById('p2score').textContent=`P2 ${s.scores?.p2||0}`;
  const p1=s.players?.p1,p2=s.players?.p2;
  const l1=document.getElementById('lives-p1'),l2=document.getElementById('lives-p2');
  if(l1&&p1)l1.innerHTML=Array.from({length:MAX_LIVES},(_,i)=>`<span style="opacity:${i<p1.lives?1:0.18}">♥</span>`).join('');
  if(l2&&p2)l2.innerHTML=Array.from({length:MAX_LIVES},(_,i)=>`<span style="opacity:${i<p2.lives?1:0.18}">♥</span>`).join('');
  if(s.phase==='waiting')document.getElementById('status').textContent='Waiting for players...';
  const rnd=document.getElementById('roundNum');
  if(rnd)rnd.textContent=`Round ${s.roundNum||1}`;
  const p=myId&&s.players[myId];
  if(p&&window.updateWeaponStrip)updateWeaponStrip(p.weapon,myAmmo);
}

// ── Particles ─────────────────────────────────────────────────
function spawnParticles(x,y,color,count){
  for(let i=0;i<count;i++){
    const ang=Math.random()*Math.PI*2,spd=1.5+Math.random()*5;
    particles.push({x,y,vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,life:1,decay:0.022+Math.random()*0.04,r:2+Math.random()*3.5,color});
  }
}
function triggerShake(mag,dur){screenShake={mag,dur,start:Date.now()};}

// ── Auto-aim ──────────────────────────────────────────────────
// Both PC and mobile: find nearest enemy, smooth-track the aim angle
function computeAutoAim(){
  const me=myId&&state.players[myId];
  if(!me||me.dead){autoAimTarget=null;return;}

  let closest=null,closestDist=Infinity;
  for(const[pid,p]of Object.entries(state.players)){
    if(pid===myId||p.dead)continue;
    const dx=p.x-me.x,dy=p.y-me.y;
    const dist=Math.sqrt(dx*dx+dy*dy);
    if(dist<closestDist){closestDist=dist;closest=p;}
  }

  if(closest){
    autoAimTarget={x:closest.x,y:closest.y};
    const target=Math.atan2(closest.y-me.y,closest.x-me.x);
    let diff=target-autoAimAngle;
    while(diff>Math.PI)diff-=Math.PI*2;
    while(diff<-Math.PI)diff+=Math.PI*2;
    const snap=closestDist<150?0.20:0.12;
    autoAimAngle+=diff*snap;
  } else {
    autoAimTarget=null;
    // PC fallback: track mouse
    if(!isMobile){
      const me2=myId&&state.players[myId];
      if(me2)autoAimAngle=Math.atan2(mousePos.y-me2.y,mousePos.x-me2.x);
    }
  }
}

function getAimAngle(){
  if(autoAimTarget)return autoAimAngle;
  const p=myId&&state.players[myId];
  if(!p)return 0;
  return Math.atan2(mousePos.y-p.y,mousePos.x-p.x);
}

// ── Weapon switch — edge-triggered (fires once per press) ─────
function checkWeaponSwitch(){
  const wMap={'1':'pistol','2':'shotgun','3':'sniper','4':'smg','5':'rocket'};
  let sw=null;
  for(const[k,w]of Object.entries(wMap)){
    const now=!!(keys[k]),was=!!(prevKeyState[k]);
    if(now&&!was)sw=w;
    prevKeyState[k]=now;
  }
  if(pendingWeaponSwitch){sw=pendingWeaponSwitch;pendingWeaponSwitch=null;}
  return sw;
}
window._forceWeaponSwitch=w=>{pendingWeaponSwitch=w;};

// ── Input listeners ───────────────────────────────────────────
canvas.addEventListener('mousemove',e=>{
  const r=canvas.getBoundingClientRect();
  mousePos.x=(e.clientX-r.left)*(W/r.width);
  mousePos.y=(e.clientY-r.top)*(H/r.height);
});
canvas.addEventListener('mousedown',e=>{if(e.button===0){mouseDown=true;getAudio();}});
canvas.addEventListener('mouseup',e=>{if(e.button===0)mouseDown=false;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());

document.addEventListener('keydown',e=>{
  if(chatVisible){
    if(e.key==='Escape'){chatVisible=false;chatInput='';return;}
    if(e.key==='Enter'){if(chatInput.trim())socket.emit('chat',chatInput.trim());chatVisible=false;chatInput='';return;}
    if(e.key==='Backspace'){chatInput=chatInput.slice(0,-1);return;}
    if(e.key.length===1){chatInput+=e.key;return;}
    return;
  }
  if(e.key==='t'||e.key==='T'){chatVisible=true;e.preventDefault();return;}
  keys[e.key.toLowerCase()]=true;
  keys[e.key]=true;
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))e.preventDefault();
});
document.addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;keys[e.key]=false;});

function sendInput(){
  if(state.phase!=='playing'||!myId)return;
  const now=Date.now();
  let shoot,grenade,dash;

  if(isMobile){
    shoot=mobileShoot;grenade=mobileGrenade;dash=mobileDash;
  } else {
    shoot=mouseDown;
    grenade=keys['g']||keys['p'];   // G or P for grenade (both players)
    dash=keys['shift']||keys['Shift'];
  }

  if(grenade)window._lastGrenade=now;
  if(dash)window._lastDash=now;

  computeAutoAim();
  const switchWeapon=checkWeaponSwitch();

  // Convert joystick to directional flags (threshold 0.25 so small nudges register)
  const jx = joystick.active ? joystick.dx : 0;
  const jy = joystick.active ? joystick.dy : 0;
  const JT = 0.25;

  socket.emit('input',{
    up:    keys['w']||keys['arrowup']   ||keys['ArrowUp']    ||(jy < -JT),
    down:  keys['s']||keys['arrowdown'] ||keys['ArrowDown']  ||(jy >  JT),
    left:  keys['a']||keys['arrowleft'] ||keys['ArrowLeft']  ||(jx < -JT),
    right: keys['d']||keys['arrowright']||keys['ArrowRight'] ||(jx >  JT),
    shoot,grenade,dash,
    aimAngle:getAimAngle(),
    switchWeapon,
  });
}

// ── Mobile controls ───────────────────────────────────────────
function setupMobileControls(){
  if(!isMobile)return;
  document.getElementById('mobile-ui').style.display='flex';
  document.getElementById('mobile-wep-strip').style.display='flex';

  const stick=document.getElementById('joystick-base');
  const knob=document.getElementById('joystick-knob');

  stick.addEventListener('touchstart',e=>{
    const t=e.touches[0],r=stick.getBoundingClientRect();
    joystick.active=true;joystick.startX=r.left+r.width/2;joystick.startY=r.top+r.height/2;joystick.id=t.identifier;
    e.preventDefault();
  },{passive:false});

  stick.addEventListener('touchmove',e=>{
    for(const t of e.touches){
      if(t.identifier!==joystick.id)continue;
      const dx=t.clientX-joystick.startX,dy=t.clientY-joystick.startY;
      const dist=Math.min(Math.sqrt(dx*dx+dy*dy),55),ang=Math.atan2(dy,dx);
      joystick.dx=Math.cos(ang)*dist/55;joystick.dy=Math.sin(ang)*dist/55;
      knob.style.transform=`translate(calc(-50% + ${Math.cos(ang)*dist}px),calc(-50% + ${Math.sin(ang)*dist}px))`;
    }
    e.preventDefault();
  },{passive:false});

  stick.addEventListener('touchend',()=>{
    joystick.active=false;joystick.dx=0;joystick.dy=0;
    knob.style.transform='translate(-50%,-50%)';
  });
  stick.addEventListener('touchcancel',()=>{
    joystick.active=false;joystick.dx=0;joystick.dy=0;
    knob.style.transform='translate(-50%,-50%)';
  });

  function addBtn(id,onS,onE){
    const el=document.getElementById(id);if(!el)return;
    el.addEventListener('touchstart',e=>{onS();e.preventDefault();},{passive:false});
    el.addEventListener('touchend',onE);el.addEventListener('touchcancel',onE);
  }
  addBtn('shoot-btn',()=>{mobileShoot=true;getAudio();},()=>mobileShoot=false);
  addBtn('grenade-btn',()=>mobileGrenade=true,()=>mobileGrenade=false);
  addBtn('dash-btn',()=>mobileDash=true,()=>mobileDash=false);

  document.querySelectorAll('.mobile-wep-btn').forEach(b=>{
    b.addEventListener('touchstart',e=>{window._forceWeaponSwitch(b.dataset.w);e.preventDefault();},{passive:false});
  });
}

// ── DRAW functions ────────────────────────────────────────────
function drawArena(){
  const grad=ctx.createRadialGradient(W/2,H/2,60,W/2,H/2,600);
  grad.addColorStop(0,'#0f1428');grad.addColorStop(1,'#060810');
  ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);

  ctx.strokeStyle='#141828';ctx.lineWidth=1;
  for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

  ctx.setLineDash([10,10]);ctx.strokeStyle='#ffffff08';ctx.lineWidth=2;
  ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle='#4fc3f730';ctx.lineWidth=4;ctx.strokeRect(2,2,W-4,H-4);
  ctx.strokeStyle='#4fc3f710';ctx.lineWidth=12;ctx.strokeRect(8,8,W-16,H-16);
}

function drawHazardZones(){
  for(const hz of(state.hazardZones||[])){
    const t=Date.now()/1000,pulse=0.5+0.5*Math.sin(t*3+hz.id);
    const alpha=0.15+0.1*pulse,r=hz.r*(0.95+0.05*pulse);
    const grd=ctx.createRadialGradient(hz.x,hz.y,0,hz.x,hz.y,r);
    grd.addColorStop(0,`rgba(255,60,0,${alpha+0.1})`);
    grd.addColorStop(0.6,`rgba(255,100,0,${alpha})`);
    grd.addColorStop(1,'rgba(255,60,0,0)');
    ctx.beginPath();ctx.arc(hz.x,hz.y,r,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill();
    ctx.strokeStyle=`rgba(255,120,0,${0.3+0.2*pulse})`;ctx.lineWidth=2;ctx.stroke();
    ctx.fillStyle=`rgba(255,180,0,${0.6+0.3*pulse})`;
    ctx.font='bold 12px Courier New';ctx.textAlign='center';
    ctx.fillText('⚠ HAZARD',hz.x,hz.y+4);
  }
}

function drawObstacles(){
  for(const o of(state.obstacles||[])){
    ctx.fillStyle='#00000099';ctx.fillRect(o.x+4,o.y+4,o.w,o.h);
    const grd=ctx.createLinearGradient(o.x,o.y,o.x,o.y+o.h);
    grd.addColorStop(0,'#2a3850');grd.addColorStop(1,'#1a2438');
    ctx.fillStyle=grd;ctx.fillRect(o.x,o.y,o.w,o.h);
    ctx.strokeStyle='#4a6480';ctx.lineWidth=1.5;ctx.strokeRect(o.x,o.y,o.w,o.h);
    ctx.fillStyle='#ffffff22';ctx.fillRect(o.x,o.y,o.w,3);
    ctx.fillStyle='#ffffff06';
    for(let ix=o.x+8;ix<o.x+o.w-4;ix+=12)ctx.fillRect(ix,o.y+5,5,o.h-10);
  }
}

function drawPowerups(){
  const now=Date.now();
  for(const pu of(state.powerups||[])){
    const pulse=0.82+0.18*Math.sin(now/280),rot=now/1200;
    const col=POWERUP_COLORS[pu.type]||'#fff';
    ctx.save();ctx.translate(pu.x,pu.y);ctx.scale(pulse,pulse);
    const grd=ctx.createRadialGradient(0,0,0,0,0,28);
    grd.addColorStop(0,col+'66');grd.addColorStop(1,'transparent');
    ctx.beginPath();ctx.arc(0,0,28,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill();
    ctx.rotate(rot);
    ctx.beginPath();
    for(let i=0;i<6;i++){const a=i/6*Math.PI*2,a2=(i+0.4)/6*Math.PI*2;ctx.arc(0,0,20,a,a2);}
    ctx.strokeStyle=col;ctx.lineWidth=2.5;ctx.stroke();
    ctx.rotate(-rot);
    ctx.beginPath();ctx.arc(0,0,13,0,Math.PI*2);
    ctx.fillStyle=col+'44';ctx.fill();ctx.strokeStyle=col+'cc';ctx.lineWidth=1.5;ctx.stroke();
    ctx.fillStyle=col;ctx.font='bold 9px Courier New';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(POWERUP_LABELS[pu.type]||'?',0,0);
    ctx.restore();
  }
}

function drawAutoAimIndicator(){
  const me=myId&&state.players[myId];
  if(!me||me.dead||!autoAimTarget)return;
  const myColor=COLORS[myId]?.body||'#4fc3f7';
  ctx.save();
  ctx.setLineDash([5,7]);
  ctx.strokeStyle=myColor+'35';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(me.x,me.y);ctx.lineTo(autoAimTarget.x,autoAimTarget.y);ctx.stroke();
  ctx.setLineDash([]);
  const t=Date.now()/500,pulse=0.7+0.3*Math.sin(t*Math.PI*2),cr=14*pulse;
  ctx.strokeStyle=myColor+'cc';ctx.lineWidth=2;
  ctx.beginPath();ctx.arc(autoAimTarget.x,autoAimTarget.y,cr,0,Math.PI*2);ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(autoAimTarget.x-cr-5,autoAimTarget.y);ctx.lineTo(autoAimTarget.x-cr+4,autoAimTarget.y);
  ctx.moveTo(autoAimTarget.x+cr-4,autoAimTarget.y);ctx.lineTo(autoAimTarget.x+cr+5,autoAimTarget.y);
  ctx.moveTo(autoAimTarget.x,autoAimTarget.y-cr-5);ctx.lineTo(autoAimTarget.x,autoAimTarget.y-cr+4);
  ctx.moveTo(autoAimTarget.x,autoAimTarget.y+cr-4);ctx.lineTo(autoAimTarget.x,autoAimTarget.y+cr+5);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(p){
  if(p.dead){
    ctx.save();ctx.globalAlpha=0.22;
    ctx.beginPath();ctx.arc(p.x,p.y,18,0,Math.PI*2);
    ctx.fillStyle=COLORS[p.id]?.dark||'#333';ctx.fill();ctx.restore();
    const sec=Math.ceil((p.respawnTimer||0)/60);
    ctx.fillStyle='#ffffff99';ctx.font='bold 15px Courier New';
    ctx.textAlign='center';ctx.fillText(sec+'s',p.x,p.y+5);
    ctx.font='10px Courier New';ctx.fillStyle='#ffffff55';
    ctx.fillText('RESPAWNING',p.x,p.y+22);return;
  }
  const c=COLORS[p.id]||COLORS.p1,r=18;
  ctx.save();ctx.translate(p.x,p.y);

  if(p.invincible){
    const rbow=`hsl(${(Date.now()/5)%360},100%,60%)`;
    ctx.beginPath();ctx.arc(0,0,r+14,0,Math.PI*2);
    ctx.strokeStyle=rbow+'bb';ctx.lineWidth=4;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,r+9,0,Math.PI*2);
    ctx.strokeStyle=rbow+'44';ctx.lineWidth=7;ctx.stroke();
  }
  if(p.shield){
    ctx.beginPath();ctx.arc(0,0,r+11,0,Math.PI*2);
    ctx.strokeStyle='#40c4ffbb';ctx.lineWidth=3;ctx.stroke();
    ctx.fillStyle='#40c4ff14';ctx.fill();
  }
  if(p.rapidfire){ctx.beginPath();ctx.arc(0,0,r+6,0,Math.PI*2);ctx.fillStyle='#ff6e4020';ctx.fill();}
  if((p.speed||4)>4){
    ctx.save();ctx.rotate(-p.angle);
    for(let i=0;i<4;i++){
      ctx.beginPath();ctx.arc(-r-8-i*7,0,3.5-i*0.6,0,Math.PI*2);
      ctx.fillStyle=`rgba(105,240,174,${0.55-i*0.12})`;ctx.fill();
    }
    ctx.restore();
  }
  if(p.tripleshot){ctx.beginPath();ctx.arc(0,0,r+7,0,Math.PI*2);ctx.fillStyle='#ffeb3b18';ctx.fill();}

  ctx.beginPath();ctx.arc(3,4,r,0,Math.PI*2);ctx.fillStyle='#00000077';ctx.fill();

  ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);
  const bGrad=ctx.createRadialGradient(-5,-5,2,0,0,r);
  bGrad.addColorStop(0,c.body);bGrad.addColorStop(1,c.dark);
  ctx.fillStyle=bGrad;ctx.fill();
  ctx.strokeStyle=c.body+'ee';ctx.lineWidth=2.5;ctx.stroke();
  ctx.beginPath();ctx.arc(-5,-5,7,0,Math.PI*2);ctx.fillStyle='#ffffff1a';ctx.fill();

  ctx.rotate(p.angle);
  const wc=WEAPON_COLORS[p.weapon]||c.body;
  const gl=p.weapon==='sniper'?32:p.weapon==='shotgun'?16:p.weapon==='rocket'?22:p.weapon==='smg'?18:16;
  const gh=p.weapon==='shotgun'?11:p.weapon==='rocket'?9:8;
  ctx.fillStyle='#00000077';ctx.fillRect(r-1,-(gh/2)+2,gl,gh);
  ctx.fillStyle=wc;ctx.fillRect(r-2,-gh/2,gl,gh);
  ctx.fillStyle='#ffffff40';ctx.fillRect(r-2,-gh/2,gl,3);
  ctx.beginPath();ctx.arc(r+gl-2,0,gh/2,0,Math.PI*2);ctx.fillStyle=wc;ctx.fill();
  ctx.restore();

  for(let i=0;i<MAX_HP;i++){
    const bx=p.x-(MAX_HP*11)/2+i*11+5,by=p.y-r-17;
    ctx.beginPath();ctx.arc(bx,by,4.5,0,Math.PI*2);
    ctx.fillStyle=i<p.hp?c.body:'#1a1a2e';ctx.fill();
    ctx.strokeStyle=i<p.hp?c.body+'88':'#2a2a3e';ctx.lineWidth=1;ctx.stroke();
  }

  const isMe=p.id===myId;
  const tag=p.id.toUpperCase()+(p.weapon!=='pistol'?` [${p.weapon.slice(0,3).toUpperCase()}]`:'')+( p.isBot?' 🤖':isMe?' ◀':'');
  ctx.fillStyle=isMe?c.body:'#ffffffaa';
  ctx.font=`bold ${isMe?12:10}px Courier New`;ctx.textAlign='center';
  ctx.fillText(tag,p.x,p.y+r+19);
}

function drawBullets(){
  for(const b of state.bullets){
    const r=b.weapon==='sniper'?5:b.weapon==='shotgun'?3.5:b.weapon==='rocket'?8:5.5;
    ctx.beginPath();ctx.arc(b.x,b.y,r+7,0,Math.PI*2);ctx.fillStyle=(b.color||'#fff')+'20';ctx.fill();
    ctx.beginPath();ctx.arc(b.x,b.y,r,0,Math.PI*2);ctx.fillStyle=b.color||'#fff';ctx.fill();
    if(b.weapon==='sniper'){
      ctx.beginPath();ctx.moveTo(b.x-b.vx*4,b.y-b.vy*4);ctx.lineTo(b.x,b.y);
      ctx.strokeStyle=(b.color||'#fff')+'55';ctx.lineWidth=2;ctx.stroke();
    }
    if(b.weapon==='rocket'){
      ctx.beginPath();ctx.arc(b.x-b.vx*2,b.y-b.vy*2,5,0,Math.PI*2);ctx.fillStyle='#ff600099';ctx.fill();
      ctx.beginPath();ctx.arc(b.x-b.vx*4,b.y-b.vy*4,3,0,Math.PI*2);ctx.fillStyle='#ffea0055';ctx.fill();
    }
  }
}

function drawGrenades(){
  for(const g of(state.grenades||[])){
    const pulse=0.7+0.3*Math.sin(Date.now()/80);
    ctx.beginPath();ctx.arc(g.x+2,g.y+2,9,0,Math.PI*2);ctx.fillStyle='#00000055';ctx.fill();
    ctx.beginPath();ctx.arc(g.x,g.y,9,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,${Math.floor(80+pulse*120)},0,0.95)`;ctx.fill();
    ctx.strokeStyle='#fff9';ctx.lineWidth=1.5;ctx.stroke();
    const fusePct=(g.fuse||0)/120;
    ctx.beginPath();ctx.arc(g.x,g.y,13,-Math.PI/2,-Math.PI/2+fusePct*Math.PI*2);
    ctx.strokeStyle='#ffea00';ctx.lineWidth=3;ctx.stroke();
  }
}

function drawParticles(){
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i];
    if(p.ring){
      p.r+=(p.maxR-p.r)*0.14;p.life-=p.decay;
      if(p.life<=0){particles.splice(i,1);continue;}
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.strokeStyle=`rgba(255,109,0,${p.life*0.8})`;ctx.lineWidth=3;ctx.stroke();
      ctx.beginPath();ctx.arc(p.x,p.y,p.r*0.6,0,Math.PI*2);
      ctx.strokeStyle=`rgba(255,220,0,${p.life*0.5})`;ctx.lineWidth=1.5;ctx.stroke();
      continue;
    }
    p.x+=p.vx;p.y+=p.vy;p.vx*=0.91;p.vy*=0.91;p.life-=p.decay;
    if(p.life<=0){particles.splice(i,1);continue;}
    ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);
    ctx.fillStyle=p.color+Math.floor(p.life*255).toString(16).padStart(2,'0');
    ctx.fill();
  }
}

function drawKillFeed(){
  const entries=state.killFeed||[];if(!entries.length)return;
  entries.slice(0,5).forEach((e,i)=>{
    const alpha=0.9-i*0.16;
    const text=`${e.killer.toUpperCase()} ❯ ${e.victim.toUpperCase()} [${(e.weapon||'pistol').toUpperCase()}]`;
    ctx.font='bold 11px Courier New';
    const tw=ctx.measureText(text).width;
    ctx.fillStyle=`rgba(0,0,0,${alpha*0.6})`;ctx.fillRect(W-tw-26,8+i*24,tw+20,20);
    ctx.strokeStyle=`rgba(255,255,255,${alpha*0.12})`;ctx.lineWidth=1;ctx.strokeRect(W-tw-26,8+i*24,tw+20,20);
    ctx.fillStyle=`rgba(255,255,255,${alpha})`;ctx.textAlign='right';
    ctx.fillText(text,W-13,22+i*24);
  });
}

function drawCooldowns(){
  const p=myId&&state.players[myId];if(!p||p.dead)return;
  const now=Date.now();
  [{label:'GRENADE',last:window._lastGrenade||0,cd:2000,color:'#ffea00'},
   {label:'DASH',   last:window._lastDash||0,   cd:1200,color:'#69f0ae'}].forEach((item,i)=>{
    const pct=Math.min((now-item.last)/item.cd,1);
    const bx=12,by=H-58+i*28;
    ctx.fillStyle='#00000077';ctx.fillRect(bx,by,138,20);
    ctx.fillStyle=pct>=1?item.color:item.color+'44';ctx.fillRect(bx,by,138*pct,20);
    ctx.strokeStyle=item.color+'44';ctx.lineWidth=1;ctx.strokeRect(bx,by,138,20);
    ctx.fillStyle='#fff';ctx.font='bold 9px Courier New';ctx.textAlign='left';
    const remaining=Math.max(0,(item.cd-(now-item.last))/1000).toFixed(1);
    ctx.fillText(item.label+(pct>=1?' ✓ READY':'  '+remaining+'s'),bx+5,by+13);
  });
}

function drawAmmoHUD(){
  const p=myId&&state.players[myId];if(!p||p.dead)return;
  const wep=p.weapon||'pistol',ammoVal=myAmmo[wep];
  const ammoStr=ammoVal===Infinity?'∞':String(ammoVal||0);
  const wColor=WEAPON_COLORS[wep]||'#fff';
  const wx=W-12,wy=H-64;
  ctx.fillStyle='#00000088';ctx.fillRect(wx-162,wy-24,162,52);
  ctx.strokeStyle=wColor+'44';ctx.lineWidth=1;ctx.strokeRect(wx-162,wy-24,162,52);
  ctx.fillStyle=wColor;ctx.font='bold 14px Courier New';ctx.textAlign='right';
  ctx.fillText('[ '+wep.toUpperCase()+' ]',wx,wy);
  ctx.fillStyle='#fff';ctx.font='bold 24px Courier New';ctx.fillText(ammoStr,wx,wy+24);
  ctx.fillStyle='#ffffff44';ctx.font='8px Courier New';ctx.fillText('1-5: switch weapon',wx,wy+38);
}

function drawMinimap(){
  const mx=W-110,my=H-90,mw=97,mh=70;
  ctx.fillStyle='#00000077';ctx.fillRect(mx-2,my-2,mw+4,mh+4);
  ctx.strokeStyle='#ffffff18';ctx.lineWidth=1;ctx.strokeRect(mx,my,mw,mh);
  for(const o of(state.obstacles||[])){
    ctx.fillStyle='#4a6080bb';ctx.fillRect(mx+o.x/W*mw,my+o.y/H*mh,o.w/W*mw,o.h/H*mh);
  }
  for(const[pid,p]of Object.entries(state.players)){
    if(p.dead)continue;
    ctx.beginPath();ctx.arc(mx+p.x/W*mw,my+p.y/H*mh,4,0,Math.PI*2);
    ctx.fillStyle=COLORS[pid]?.body||'#fff';ctx.fill();
    if(pid===myId){ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();}
  }
  ctx.fillStyle='#ffffff44';ctx.font='bold 7px Courier New';ctx.textAlign='left';
  ctx.fillText('MAP',mx+2,my+mh-3);
}

function drawChat(){
  const msgs=chatMessages.slice(0,5);
  if(!msgs.length&&!chatVisible)return;
  const cx=12,cy=H-135;
  msgs.forEach((m,i)=>{
    const alpha=1-i*0.2;
    const text=`${m.pid.toUpperCase()}: ${m.text}`;
    ctx.font='10px Courier New';const tw=ctx.measureText(text).width;
    ctx.fillStyle=`rgba(0,0,0,${alpha*0.55})`;ctx.fillRect(cx,cy-i*18,tw+12,16);
    ctx.fillStyle=`rgba(255,255,255,${alpha})`;ctx.textAlign='left';
    ctx.fillText(text,cx+5,cy+11-i*18);
  });
  if(chatVisible){
    ctx.fillStyle='#000000aa';ctx.fillRect(cx,cy-msgs.length*18-24,260,22);
    ctx.fillStyle='#69f0ae';ctx.font='10px Courier New';ctx.textAlign='left';
    ctx.fillText('> '+chatInput+'_',cx+5,cy-msgs.length*18-7);
  }
}

function drawToasts(){
  toasts.forEach((t,i)=>{
    ctx.save();
    ctx.font='bold 18px Courier New';ctx.textAlign='center';ctx.globalAlpha=0.93;
    ctx.shadowColor=t.color||'#fff';ctx.shadowBlur=14;
    ctx.fillStyle=t.color||'#fff';ctx.fillText(t.msg,t.x,t.y-i*28);
    ctx.restore();
  });
}

function drawStatsScreen(data){
  if(!data||statsTimer<=0)return;statsTimer--;
  const alpha=Math.min(1,(220-statsTimer)/15)*Math.min(1,statsTimer/15);
  const bx=W/2-230,by=H/2-175,bw=460,bh=350;
  ctx.fillStyle=`rgba(5,8,20,${alpha*0.94})`;ctx.fillRect(bx,by,bw,bh);
  ctx.strokeStyle=`rgba(100,180,255,${alpha*0.5})`;ctx.lineWidth=2;ctx.strokeRect(bx,by,bw,bh);
  const isWinner=data.winner===myId;
  ctx.fillStyle=isWinner?`rgba(105,240,174,${alpha})`:`rgba(255,82,82,${alpha})`;
  ctx.font=`bold 34px Courier New`;ctx.textAlign='center';
  ctx.fillText(isWinner?'🏆 MATCH WIN!':'MATCH OVER',W/2,by+58);
  ctx.fillStyle=`rgba(255,255,255,${alpha*0.7})`;ctx.font='13px Courier New';
  ctx.fillText(`Score: P1 ${data.scores?.p1||0} — P2 ${data.scores?.p2||0}`,W/2,by+88);
  const stats=data.stats||{};
  ['p1','p2'].forEach((pid,col)=>{
    const s=stats[pid]||{},px=bx+75+col*220,py=by+118;
    ctx.fillStyle=`rgba(${pid==='p1'?'79,195,247':'239,154,154'},${alpha})`;
    ctx.font='bold 14px Courier New';ctx.textAlign='center';
    ctx.fillText(pid.toUpperCase()+(s.isBot?' (BOT)':'')+(pid===myId?' ◀':''),px+45,py);
    [['Kills',s.kills||0],['Deaths',s.deaths||0],['Damage',s.damageDealt||0],['Shots',s.shotsFired||0],
     ['KDR',s.deaths?(s.kills/s.deaths).toFixed(1):'∞']].forEach(([k,v],i)=>{
      ctx.fillStyle=`rgba(255,255,255,${alpha*0.6})`;ctx.textAlign='left';ctx.font='11px Courier New';
      ctx.fillText(k,px,py+24+i*26);
      ctx.fillStyle=`rgba(255,255,255,${alpha*0.9})`;ctx.textAlign='right';ctx.font='bold 11px Courier New';
      ctx.fillText(String(v),px+90,py+24+i*26);
    });
  });
  ctx.fillStyle=`rgba(255,255,255,${alpha*0.35})`;ctx.font='10px Courier New';ctx.textAlign='center';
  ctx.fillText('Next round starting...',W/2,by+bh-20);
}

function drawWaiting(){
  ctx.fillStyle='#ffffff20';ctx.font='bold 30px Courier New';ctx.textAlign='center';
  ctx.fillText('WAITING FOR PLAYERS',W/2,H/2-14);
  ctx.font='14px Courier New';ctx.fillStyle='#ffffff44';
  ctx.fillText('Open in two tabs or on two devices to play',W/2,H/2+30);
  const dots='.'.repeat((Math.floor(Date.now()/400)%4));
  ctx.fillStyle='#4fc3f766';ctx.font='22px Courier New';ctx.fillText(dots,W/2,H/2+65);
}

// ── Render loop ───────────────────────────────────────────────
function render(){
  const now=Date.now();
  let sx=0,sy=0;
  if(screenShake.dur>0){
    const prog=(now-screenShake.start)/screenShake.dur;
    if(prog<1){const m=screenShake.mag*(1-prog);sx=(Math.random()-.5)*m;sy=(Math.random()-.5)*m;}
  }
  ctx.save();ctx.translate(sx,sy);
  drawArena();
  drawHazardZones();
  drawObstacles();
  drawPowerups();
  if(state.phase==='waiting')drawWaiting();
  drawAutoAimIndicator();
  for(const p of Object.values(state.players))drawPlayer(p);
  drawBullets();
  drawGrenades();
  drawParticles();
  drawKillFeed();
  drawCooldowns();
  drawAmmoHUD();
  drawMinimap();
  drawChat();
  drawToasts();
  if(statsScreen&&statsTimer>0)drawStatsScreen(statsScreen);
  ctx.restore();
  requestAnimationFrame(render);
}

setInterval(sendInput,1000/60);
setupMobileControls();
render();