import * as THREE from 'three';

/* ---------- constants (SI, y-up, table centred on origin) ---------- */
const TL = 2.74, TW = 1.525, TH = 0.76;          // table length / width / height
const HX = TW / 2, HZ = TL / 2;
const NET_H = 0.1525, NET_OVER = 0.1525;
const R = 0.02, G = 9.81;
const DRAG = 0.112;      // 0.5*rho*Cd*A/m
const MAGNUS = 0.0016;   // accel = MAGNUS * (w x v)
const E_TABLE = 0.86;    // restitution
const WIN = 11;

const DIFFS = {
  facil:  { name:'Fácil',   speed:1.55, react:0.34, err:0.20, power:0.80, spin:0.35, reach:0.30 },
  normal: { name:'Normal',  speed:2.35, react:0.22, err:0.115,power:0.95, spin:0.65, reach:0.42 },
  dificil:{ name:'Difícil', speed:3.20, react:0.14, err:0.062,power:1.08, spin:0.95, reach:0.52 },
  experto:{ name:'Experto', speed:4.20, react:0.08, err:0.030,power:1.18, spin:1.25, reach:0.62 },
};

/* ---------- renderer / scene ---------- */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#141017');
scene.fog = new THREE.Fog('#141017', 8, 22);

const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
const CAMS = {
  player: { pos:new THREE.Vector3(0, 1.95, 3.15), look:new THREE.Vector3(0, 0.88, -0.20), label:'jugador' },
  alta:   { pos:new THREE.Vector3(0, 3.10, 2.45), look:new THREE.Vector3(0, 0.80, -0.10), label:'alta' },
  lateral:{ pos:new THREE.Vector3(3.15, 1.85, 1.55), look:new THREE.Vector3(0, 0.88, 0), label:'lateral' },
};
let camKey = 'player';

/* lights */
scene.add(new THREE.HemisphereLight('#cfd6e6', '#2a2130', 0.85));
const key = new THREE.DirectionalLight('#ffffff', 2.3);
key.position.set(2.4, 5.2, 2.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -2.4; key.shadow.camera.right = 2.4;
key.shadow.camera.top = 3.0; key.shadow.camera.bottom = -3.0;
key.shadow.camera.near = 1; key.shadow.camera.far = 12;
key.shadow.bias = -0.0006;
scene.add(key);
const rim = new THREE.DirectionalLight('#8fb8ff', 0.7);
rim.position.set(-3, 2.6, -3.5);
scene.add(rim);

/* materials */
const M = {
  cloth:  new THREE.MeshStandardMaterial({ color:'#1d5a86', roughness:0.86, metalness:0.02 }),
  line:   new THREE.MeshStandardMaterial({ color:'#f4f6f8', roughness:0.7 }),
  frame:  new THREE.MeshStandardMaterial({ color:'#171317', roughness:0.55, metalness:0.25 }),
  metal:  new THREE.MeshStandardMaterial({ color:'#8d8f96', roughness:0.38, metalness:0.85 }),
  net:    new THREE.MeshStandardMaterial({ color:'#e8e9ee', roughness:0.9, transparent:true, opacity:0.55, side:THREE.DoubleSide }),
  ball:   new THREE.MeshStandardMaterial({ color:'#fff4d6', roughness:0.42, metalness:0.0, emissive:'#3a2b12', emissiveIntensity:0.35 }),
  seam:   new THREE.MeshStandardMaterial({ color:'#d8a03a', roughness:0.5 }),
  rubberP:new THREE.MeshStandardMaterial({ color:'#714B67', roughness:0.78 }),
  rubberA:new THREE.MeshStandardMaterial({ color:'#017E84', roughness:0.78 }),
  blade:  new THREE.MeshStandardMaterial({ color:'#c99a63', roughness:0.62 }),
  grip:   new THREE.MeshStandardMaterial({ color:'#2a2228', roughness:0.75 }),
  floor:  new THREE.MeshStandardMaterial({ color:'#221b26', roughness:0.95 }),
};

/* floor */
const floor = new THREE.Mesh(new THREE.CircleGeometry(11, 64), M.floor);
floor.rotation.x = -Math.PI/2; floor.receiveShadow = true;
scene.add(floor);

/* ---------- table ---------- */
const table = new THREE.Group(); scene.add(table);
const top = new THREE.Mesh(new THREE.BoxGeometry(TW, 0.03, TL), M.cloth);
top.position.y = TH - 0.015; top.receiveShadow = true; top.castShadow = true;
table.add(top);
const addLine = (w, l, x, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.004, l), M.line);
  m.position.set(x, TH + 0.001, z); table.add(m);
};
addLine(0.02, TL, -HX + 0.01, 0); addLine(0.02, TL, HX - 0.01, 0);
addLine(TW, 0.02, 0, -HZ + 0.01); addLine(TW, 0.02, 0, HZ - 0.01);
addLine(0.015, TL, 0, 0);
for (const s of [-1, 1]) {
  const ap = new THREE.Mesh(new THREE.BoxGeometry(0.06, TH - 0.03, 0.06), M.frame);
  ap.position.set(0, (TH - 0.03)/2, s*(HZ - 0.06)); table.add(ap);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, TH - 0.04, 20), M.metal);
    leg.position.set(sx*(HX - 0.12), (TH - 0.04)/2, s*(HZ - 0.22));
    leg.castShadow = true; table.add(leg);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(TW - 0.16, 0.05, 0.05), M.frame);
  rail.position.set(0, TH - 0.22, s*(HZ - 0.22)); table.add(rail);
}
/* net */
const netW = TW + NET_OVER*2;
const netMesh = new THREE.Mesh(new THREE.PlaneGeometry(netW, NET_H), M.net);
netMesh.position.set(0, TH + NET_H/2, 0); table.add(netMesh);
const netTape = new THREE.Mesh(new THREE.BoxGeometry(netW, 0.014, 0.008), M.line);
netTape.position.set(0, TH + NET_H, 0); table.add(netTape);
for (const sx of [-1, 1]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, NET_H + 0.02, 16), M.metal);
  post.position.set(sx*netW/2, TH + (NET_H + 0.02)/2, 0); table.add(post);
}

/* ---------- paddles ---------- */
function makePaddle(rubber) {
  const g = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.083, 0.083, 0.008, 40), M.blade);
  blade.rotation.x = Math.PI/2; blade.castShadow = true; g.add(blade);
  for (const s of [-1, 1]) {
    const rb = new THREE.Mesh(new THREE.CylinderGeometry(0.081, 0.081, 0.004, 40), rubber);
    rb.rotation.x = Math.PI/2; rb.position.z = s*0.0062; rb.castShadow = true; g.add(rb);
  }
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.05, 0.012), M.blade);
  neck.position.y = -0.096; g.add(neck);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.023, 0.10, 20), M.grip);
  handle.position.y = -0.165; handle.castShadow = true; g.add(handle);
  scene.add(g);
  return g;
}
const pPaddle = makePaddle(M.rubberP);
const aPaddle = makePaddle(M.rubberA);
const P_Z = HZ - 0.10, A_Z = -HZ + 0.10;

/* ---------- ball ---------- */
const ball = new THREE.Group();
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), M.ball);
ballMesh.castShadow = true; ball.add(ballMesh);
const seam = new THREE.Mesh(new THREE.TorusGeometry(R*0.995, 0.0016, 8, 48), M.seam);
ball.add(seam);
const seam2 = new THREE.Mesh(new THREE.TorusGeometry(R*0.995, 0.0016, 8, 48), M.seam);
seam2.rotation.y = Math.PI/2; ball.add(seam2);
scene.add(ball);

/* trail */
const TRAIL = 46;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL*3), 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color:'#ffd98a', transparent:true, opacity:0.5 }));
trail.frustumCulled = false; scene.add(trail);
const trailPts = [];

/* bounce ring + shadow marker */
const ring = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.028, 40), new THREE.MeshBasicMaterial({ color:'#ffe9b0', transparent:true, opacity:0, side:THREE.DoubleSide }));
ring.rotation.x = -Math.PI/2; scene.add(ring);
let ringT = 0;
const marker = new THREE.Mesh(new THREE.CircleGeometry(0.028, 28), new THREE.MeshBasicMaterial({ color:'#000', transparent:true, opacity:0.28 }));
marker.rotation.x = -Math.PI/2; scene.add(marker);

/* ---------- state ---------- */
const S = {
  mode:'menu', diff:'normal', sp:0, sa:0, rallies:0, hits:0,
  server:'p', servePending:true,
  pos:new THREE.Vector3(), vel:new THREE.Vector3(), spin:new THREE.Vector3(),
  lastHit:null, serveBall:false, bouncedOwn:false, bouncedOpp:false,
  aiTarget:new THREE.Vector3(0, TH + 0.22, A_Z), aiDelay:0, aiPlan:null,
  paddle:new THREE.Vector3(0, TH + 0.20, P_Z), paddlePrev:new THREE.Vector3(0, TH + 0.20, P_Z),
  paddleVel:new THREE.Vector3(), aiPaddle:new THREE.Vector3(0, TH + 0.22, A_Z), aiPaddlePrev:new THREE.Vector3(0, TH + 0.22, A_Z),
  shake:0, hitCool:0, aiCool:0, serveTimer:1.1,
};
const mouse = { x:0, y:0 };
window.__S = S;

/* ---------- UI ---------- */
const $ = id => document.getElementById(id);
const el = { sp:$('sp'), sa:$('sa'), dLabel:$('dLabel'), serveLabel:$('serveLabel'), toast:$('toast'),
  powB:$('powB'), powV:$('powV'), spinB:$('spinB'), spinV:$('spinV'),
  start:$('startScreen'), pause:$('pauseScreen'), end:$('endScreen'), hud:$('hud'), meters:$('meters'), hint:$('hint') };

const diffsBox = $('diffs');
for (const [k, d] of Object.entries(DIFFS)) {
  const b = document.createElement('button');
  b.className = 'diff-btn' + (k === S.diff ? ' on' : '');
  b.dataset.k = k;
  const desc = { facil:'Devuelve lento y con poco efecto', normal:'Ritmo de club, algo de liftado',
    dificil:'Rápido, coloca y castiga los fallos', experto:'Reacción casi perfecta y efecto pesado' }[k];
  b.innerHTML = `<strong>${d.name}</strong><span>${desc}</span>`;
  b.onclick = () => { S.diff = k; [...diffsBox.children].forEach(c => c.classList.toggle('on', c.dataset.k === k)); };
  diffsBox.appendChild(b);
}
$('camBtn').onclick = () => cycleCam();
$('playBtn').onclick = () => startMatch();
$('resumeBtn').onclick = () => { S.mode = 'play'; el.pause.classList.add('hidden'); };
$('menuBtn').onclick = () => toMenu();
$('againBtn').onclick = () => startMatch();
$('endMenuBtn').onclick = () => toMenu();

function cycleCam() {
  const ks = Object.keys(CAMS);
  camKey = ks[(ks.indexOf(camKey) + 1) % ks.length];
  $('camBtn').textContent = 'Cámara: ' + CAMS[camKey].label;
}
function toast(main, sub, ms = 1100) {
  el.toast.innerHTML = main + (sub ? `<small>${sub}</small>` : '');
  el.toast.style.opacity = 1;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.style.opacity = 0, ms);
}
function setHudVisible(v) {
  for (const n of [el.hud, el.meters, el.hint]) n.style.opacity = v ? 1 : 0;
}
function toMenu() {
  S.mode = 'menu'; el.pause.classList.add('hidden'); el.end.classList.add('hidden');
  el.start.classList.remove('hidden'); setHudVisible(false);
}
function startMatch() {
  S.sp = S.sa = 0; S.hits = 0; S.rallies = 0; S.server = 'p';
  el.dLabel.textContent = DIFFS[S.diff].name;
  el.start.classList.add('hidden'); el.end.classList.add('hidden'); el.pause.classList.add('hidden');
  setHudVisible(true); updateScore();
  S.mode = 'play'; resetPoint();
  toast('¡A jugar!', 'Pulsa Espacio para sacar', 1400);
}
function updateScore() {
  el.sp.textContent = S.sp; el.sa.textContent = S.sa;
  el.serveLabel.textContent = 'Saca: ' + (S.server === 'p' ? 'tú' : 'la máquina');
}

/* ---------- point flow ---------- */
function resetPoint() {
  S.servePending = true; S.serveBall = false; S.lastHit = null;
  S.bouncedOwn = S.bouncedOpp = false; S.aiPlan = null; S.hitCool = 0; S.aiCool = 0;
  S.spin.set(0, 0, 0); S.vel.set(0, 0, 0);
  const z = S.server === 'p' ? P_Z - 0.12 : A_Z + 0.12;
  S.pos.set(S.server === 'p' ? S.paddle.x * 0.5 : 0, TH + 0.30, z);
  trailPts.length = 0;
  S.serveTimer = 1.1;
}
function serve(who) {
  if (!S.servePending) return;
  S.servePending = false; S.serveBall = true; S.lastHit = who;
  S.bouncedOwn = false; S.bouncedOpp = false;
  const dir = who === 'p' ? -1 : 1;
  const tx = (Math.random() * 2 - 1) * 0.42;
  const tz = dir * (0.75 + Math.random() * 0.45);
  const from = S.pos.clone();
  const speed = 5.6 + Math.random() * 0.9 + (who === 'a' ? DIFFS[S.diff].power * 0.8 : 0);
  const spinX = dir * (30 + Math.random() * 70) * (who === 'a' ? DIFFS[S.diff].spin : 0.6);
  aimShot(from, new THREE.Vector3(tx, TH, tz), speed, 0.30, S.vel);
  S.spin.set(spinX, (Math.random() * 2 - 1) * 60, 0);
  S.rallies++;
  if (who === 'p') pulse(S.vel.length(), S.spin.x * -1);
}

function point(winner, why) {
  if (S.mode !== 'play') return;
  if (winner === 'p') S.sp++; else S.sa++;
  (S._log || (S._log = [])).push(winner + ':' + why);
  S.server = (S.sp + S.sa) % 2 === 0 ? 'p' : 'a';
  updateScore();
  toast(winner === 'p' ? 'Punto para ti' : 'Punto máquina', why, 1200);
  S.mode = 'between';
  if (S.sp >= WIN || S.sa >= WIN) return setTimeout(endMatch, 900);
  setTimeout(() => { if (S.mode === 'between') { S.mode = 'play'; resetPoint(); } }, 1150);
}
function endMatch() {
  S.mode = 'over';
  reportScore();
  const won = S.sp > S.sa;
  $('endKicker').textContent = won ? 'Victoria' : 'Derrota';
  $('endTitle').textContent = won ? '¡Ganaste el partido!' : 'Gana la máquina';
  $('endScore').textContent = `${S.sp} — ${S.sa}`;
  $('endMeta').textContent = `Dificultad ${DIFFS[S.diff].name} · ${S.hits} golpes · ${S.rallies} puntos jugados`;
  el.end.classList.remove('hidden');
}

/* ---------- shot solver ---------- */
/* launch from `from` so the ball lands near `to`; speed = horizontal speed, lift = extra rise */
function aimShot(from, to, speed, lift, out) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.max(0.35, Math.hypot(dx, dz));
  const t = d / speed;
  const vy = (to.y - from.y + 0.5 * G * t * t) / t + lift * 3.2;
  out.set(dx / d * speed, vy, dz / d * speed);
}

/* ---------- physics ---------- */
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
function integrate(dt) {
  const v = S.vel, p = S.pos;
  const sp = v.length();
  // gravity + drag + Magnus
  tmp.set(0, -G, 0);
  tmp2.copy(v).multiplyScalar(-DRAG * sp);
  tmp.add(tmp2);
  tmp2.copy(S.spin).cross(v).multiplyScalar(MAGNUS);
  tmp.add(tmp2);
  v.addScaledVector(tmp, dt);
  S.spin.multiplyScalar(1 - 0.55 * dt);      // spin decay

  const prevZ = p.z, prevY = p.y;
  p.addScaledVector(v, dt);

  // table bounce
  const surf = TH + R;
  if (p.y <= surf && prevY > surf - 1e-4 && v.y < 0 && Math.abs(p.x) <= HX && Math.abs(p.z) <= HZ) {
    p.y = surf;
    v.y = -v.y * E_TABLE;
    // spin -> tangential kick (topspin accelerates, backspin brakes/reverses)
    v.z += S.spin.x * 0.0052;
    v.x += -S.spin.y * 0.0026;
    S.spin.x *= 0.55; S.spin.y *= 0.72;
    onBounce(p.z > 0 ? 'p' : 'a', p.clone());
  }
  // net
  if (prevZ * p.z <= 0 && Math.abs(p.x) <= netW/2 + R) {
    if (p.y < TH + NET_H + R * 0.6) {
      p.z = prevZ > 0 ? R * 0.9 : -R * 0.9;
      v.z *= -0.22; v.x *= 0.35; v.y *= 0.35;
      S.spin.multiplyScalar(0.3);
      toast('¡Red!', '', 700);
      S.shake = 0.35;
    }
  }
  // floor
  if (p.y <= R + 0.001) { p.y = R + 0.001; v.y = -v.y * 0.4; v.x *= 0.75; v.z *= 0.75; resolveMiss(); }
  // way out
  if (Math.abs(p.z) > 4.2 || Math.abs(p.x) > 3.2) resolveMiss();
}

function onBounce(side, at) {
  ring.position.set(at.x, TH + 0.002, at.z); ringT = 1;
  S.shake = Math.max(S.shake, 0.12);
  if (!S.lastHit) return;
  const own = S.lastHit === side;
  if (S.serveBall) {
    if (own && !S.bouncedOwn) { S.bouncedOwn = true; return; }   // legal serve bounce
    if (!own) { S.serveBall = false; S.bouncedOpp = true; return; }
    return point(S.lastHit === 'p' ? 'a' : 'p', 'Saque nulo');
  }
  if (own) return point(S.lastHit === 'p' ? 'a' : 'p', 'La bola cayó en tu propio campo');
  if (S.bouncedOpp) return point(S.lastHit, 'Doble bote — sin devolución');
  S.bouncedOpp = true;
}
function resolveMiss() {
  if (S.mode !== 'play' || !S.lastHit) { if (S.mode === 'play') point(S.server === 'p' ? 'a' : 'p', 'Bola perdida'); return; }
  const opp = S.lastHit === 'p' ? 'a' : 'p';
  if (S.bouncedOpp) point(S.lastHit, opp === 'p' ? 'No llegaste' : 'La máquina no llegó');
  else point(opp, S.lastHit === 'p' ? 'Tu bola se fue fuera' : 'Bola fuera de la máquina');
}

/* ---------- hits ---------- */
function pulse(speed, topspin) {
  el.powV.textContent = speed.toFixed(1) + ' m/s';
  const pw = Math.min(1, speed / 16);
  el.powB.style.left = '0%'; el.powB.style.width = (pw * 100).toFixed(0) + '%';
  const sn = Math.max(-1, Math.min(1, topspin / 320));
  el.spinV.textContent = Math.abs(sn) < 0.08 ? 'plano' : (sn > 0 ? 'liftado' : 'cortado');
  el.spinB.style.left = sn > 0 ? '50%' : (50 + sn * 50) + '%';
  el.spinB.style.width = Math.abs(sn) * 50 + '%';
}

function tryPlayerHit(prevZ) {
  if (S.hitCool > 0 || S.vel.z <= 0) return;
  const pz = S.paddle.z;
  if (!(prevZ <= pz && S.pos.z >= pz - 0.02)) return;
  const dx = S.pos.x - S.paddle.x, dy = S.pos.y - S.paddle.y;
  if (Math.hypot(dx, dy) > 0.115) return;
  hit('p');
}
function hit(who) {
  const isP = who === 'p';
  const pad = isP ? S.paddle : S.aiPaddle;
  const pv = isP ? S.paddleVel : new THREE.Vector3();
  const d = DIFFS[S.diff];
  const dir = isP ? -1 : 1;
  S.hits++;
  S.lastHit = who; S.serveBall = false; S.bouncedOwn = false; S.bouncedOpp = false;
  S.hitCool = isP ? 0.14 : 0.14;

  let speed, topspin, side, tx, tz, lift;
  if (isP) {
    const swing = Math.min(3.2, pv.length());
    speed = 5.8 + swing * 0.95 + Math.max(0, -S.vel.z) * 0.10;
    topspin = Math.max(-320, Math.min(320, pv.y * 105 - (pad.y - (TH + 0.20)) * 80));
    side = Math.max(-200, Math.min(200, -pv.x * 80));
    const off = (S.pos.x - pad.x);
    tx = Math.max(-0.58, Math.min(0.58, pad.x * 1.1 - off * 1.6));
    tz = -(0.50 + Math.min(0.68, swing * 0.22));
    lift = 0.19 + (topspin / 320) * 0.15;
  } else {
    speed = (6.0 + Math.random() * 1.3) * d.power;
    topspin = Math.min(320, (50 + Math.random() * 180) * d.spin);
    side = (Math.random() * 2 - 1) * 150 * d.spin;
    tx = (Math.random() * 2 - 1) * (0.30 + 0.34 * d.spin);
    tz = 0.55 + Math.random() * 0.7;
    lift = 0.20 + (topspin / 320) * 0.16 + Math.max(0, (TH + 0.16 - S.pos.y) * 0.5);
  }
  const from = S.pos.clone();
  aimShot(from, new THREE.Vector3(tx, TH + 0.02, tz), speed, lift, S.vel);
  // Magnus: a = k*(w x v). With v along z, topspin needs w.x to share the sign of v.z
  S.spin.set(dir * topspin, side, 0);
  S.shake = Math.max(S.shake, isP ? 0.28 : 0.16);
  if (isP) pulse(S.vel.length(), topspin);
  S.pos.z += dir * 0.03;
}

/* ---------- AI ---------- */
function predictLanding() {
  // integrate a copy forward until it crosses the AI hit plane
  const p = S.pos.clone(), v = S.vel.clone(), w = S.spin.clone();
  const dt = 1/240;
  for (let i = 0; i < 900; i++) {
    const sp = v.length();
    const a = new THREE.Vector3(0, -G, 0)
      .addScaledVector(v, -DRAG * sp)
      .addScaledVector(new THREE.Vector3().copy(w).cross(v), MAGNUS);
    v.addScaledVector(a, dt);
    w.multiplyScalar(1 - 0.55 * dt);
    const prevY = p.y;
    p.addScaledVector(v, dt);
    const surf = TH + R;
    if (p.y <= surf && prevY > surf && v.y < 0 && Math.abs(p.x) <= HX && Math.abs(p.z) <= HZ) {
      p.y = surf; v.y = -v.y * E_TABLE; v.z += w.x * 0.0052; v.x += -w.y * 0.0026; w.x *= 0.55; w.y *= 0.72;
    }
    if (p.z <= A_Z) return { x:p.x, y:p.y, t:i * dt, ok:p.y > TH - 0.05 };
    if (p.y < TH - 0.4) return null;
  }
  return null;
}
function aiUpdate(dt, prevZ) {
  const d = DIFFS[S.diff];
  const target = S.aiTarget;
  if (S.vel.z < -0.2 && S.mode === 'play') {
    S.aiDelay -= dt;
    if (S.aiDelay <= 0) {
      const pr = predictLanding();
      S.aiDelay = d.react;
      if (pr && pr.ok) {
        const jx = (Math.random() * 2 - 1) * d.err, jy = (Math.random() * 2 - 1) * d.err * 0.5;
        target.set(Math.max(-d.reach - 0.25, Math.min(d.reach + 0.25, pr.x + jx)),
                   Math.max(TH + 0.10, Math.min(TH + 0.52, pr.y + jy)), A_Z);
      }
    }
  } else if (S.mode === 'play') {
    target.set(target.x * 0.9, TH + 0.22, A_Z);
  }
  const ap = S.aiPaddle;
  const maxStep = d.speed * dt;
  const dx = target.x - ap.x, dy = target.y - ap.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 1e-5) {
    const s = Math.min(1, maxStep / dist);
    ap.x += dx * s; ap.y += dy * s;
  }
  ap.z = A_Z;
  // AI serve handled elsewhere; AI return:
  if (S.aiCool > 0) { S.aiCool -= dt; return; }
  if (S.vel.z < 0 && prevZ >= ap.z && S.pos.z <= ap.z + 0.02) {
    if (Math.hypot(S.pos.x - ap.x, S.pos.y - ap.y) <= 0.12) { hit('a'); S.aiCool = 0.15; }
  }
}

/* ---------- input ---------- */
addEventListener('pointermove', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = (e.clientY / innerHeight) * 2 - 1;
});
addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (S.mode === 'play' && S.servePending && S.server === 'p') serve('p');
    else if (S.mode === 'menu') startMatch();
  }
  if (e.key === 'p' || e.key === 'P') {
    if (S.mode === 'play') { S.mode = 'paused'; $('pauseScore').textContent = `${S.sp} — ${S.sa}`; el.pause.classList.remove('hidden'); }
    else if (S.mode === 'paused') { S.mode = 'play'; el.pause.classList.add('hidden'); }
  }
  if (e.key === 'c' || e.key === 'C') cycleCam();
});

/* ---------- fixed-step simulation ---------- */
function simulate(dt) {
  const steps = 6, h = dt / steps;
  for (let i = 0; i < steps; i++) {
    if (S.servePending) {
      const z = S.server === 'p' ? P_Z - 0.12 : A_Z + 0.12;
      S.pos.set(S.server === 'p' ? S.paddle.x * 0.6 : S.aiPaddle.x * 0.6, TH + 0.30, z);
      S.serveTimer -= h;
      if (S.server === 'a' && S.serveTimer <= 0) serve('a');
      break;
    }
    const prevZ = S.pos.z;
    S.hitCool = Math.max(0, S.hitCool - h);
    integrate(h);
    tryPlayerHit(prevZ);
    aiUpdate(h, prevZ);
    if (S.mode !== 'play') break;
  }
}
window.__sim = simulate;
window.__frame = frame;

/* ---------- loop ---------- */
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  const running = S.mode === 'play' || S.mode === 'between';

  // player paddle target from pointer
  if (running) {
    const tx = Math.max(-0.80, Math.min(0.80, mouse.x * 1.05));
    const ty = Math.max(TH + 0.05, Math.min(TH + 0.55, TH + 0.38 - mouse.y * 0.40));
    S.paddlePrev.copy(S.paddle);
    S.paddle.x += (tx - S.paddle.x) * Math.min(1, dt * 17);
    S.paddle.y += (ty - S.paddle.y) * Math.min(1, dt * 17);
    S.paddle.z = P_Z;
    S.paddleVel.copy(S.paddle).sub(S.paddlePrev).divideScalar(Math.max(dt, 1e-3)).multiplyScalar(0.25)
      .add(S.paddleVel.clone().multiplyScalar(0.75));
  }

  if (S.mode === 'play') simulate(dt);

  // visuals
  ball.position.copy(S.pos);
  const w = S.spin;
  if (w.lengthSq() > 1e-4) {
    const ax = tmp.copy(w).normalize();
    ballMesh.rotateOnWorldAxis(ax, Math.min(0.6, w.length() * dt * 0.35));
    seam.rotation.copy(ballMesh.rotation); seam2.rotation.copy(ballMesh.rotation); seam2.rotateY(Math.PI/2);
  }
  marker.position.set(S.pos.x, (S.pos.y > TH && Math.abs(S.pos.x) <= HX && Math.abs(S.pos.z) <= HZ) ? TH + 0.0025 : 0.003, S.pos.z);
  marker.material.opacity = 0.30 * Math.max(0.15, 1 - (S.pos.y - TH) * 0.9);

  pPaddle.position.copy(S.paddle);
  pPaddle.rotation.set(-0.32 - Math.max(-0.5, Math.min(0.5, S.paddleVel.y * 0.14)), Math.max(-0.5, Math.min(0.5, -S.paddleVel.x * 0.16)), Math.max(-0.6, Math.min(0.6, S.paddleVel.x * 0.2)));
  aPaddle.position.copy(S.aiPaddle);
  aPaddle.rotation.set(0.30, 0, 0);

  // trail
  trailPts.unshift(S.pos.clone());
  if (trailPts.length > TRAIL) trailPts.length = TRAIL;
  const arr = trailGeo.attributes.position.array;
  for (let i = 0; i < TRAIL; i++) {
    const p = trailPts[Math.min(i, trailPts.length - 1)] || S.pos;
    arr[i*3] = p.x; arr[i*3+1] = p.y; arr[i*3+2] = p.z;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trail.material.opacity = S.mode === 'play' && !S.servePending ? 0.45 : 0.12;

  if (ringT > 0) {
    ringT = Math.max(0, ringT - dt * 2.6);
    const s = 1 + (1 - ringT) * 5.5;
    ring.scale.set(s, s, s);
    ring.material.opacity = ringT * 0.7;
  }

  // camera
  const c = CAMS[camKey];
  S.shake = Math.max(0, S.shake - dt * 2.2);
  const sway = camKey === 'player' ? S.paddle.x * 0.22 : 0;
  camera.position.lerp(tmp.copy(c.pos).add(tmp2.set(sway, 0, 0)), Math.min(1, dt * 4));
  camera.position.x += (Math.random() - 0.5) * S.shake * 0.02;
  camera.position.y += (Math.random() - 0.5) * S.shake * 0.02;
  const look = tmp.copy(c.look);
  if (camKey === 'player') look.x += S.pos.x * 0.18;
  camera.lookAt(look);

  renderer.render(scene, camera);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
S.pos.set(0, TH + 0.30, P_Z - 0.12);
camera.position.copy(CAMS.player.pos);
camera.lookAt(CAMS.player.look);
pPaddle.position.copy(S.paddle);
aPaddle.position.copy(S.aiPaddle);
setHudVisible(false);
requestAnimationFrame(frame);

/* ---------- Odoo integration ---------- */
function reportScore() {
  const url = window.PINGPONG_SCORE_URL || '';
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      difficulty: S.diff,
      player_score: S.sp,
      machine_score: S.sa,
      hits: S.hits,
      rallies: S.rallies,
    }),
  }).catch(() => {});
}
