// Entry point: renderer + post-processing, input, and the game flow controller.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';
import { Engine, START_FEN, sq, sqName, type Side, type Status } from './engine';
import type { Mode } from './hud';
import { clock, colX, ease, groundHeight, lerp, rowZ, slowmo, sqPos, tick, tween, wait } from './core';
import { fx } from './fx';
import { TEAM, timeU } from './kit';
import { World } from './world';
import { Unit } from './units';
import { rig } from './camera';
import { sfx } from './audio';
import { hud } from './hud';
import { DUEL, playAttack, playBrace, playDeath, playMove } from './choreo';
import { scars } from './scars';
import { encode, hashKey, type AiRequest, type AiResult } from './ai';
import { music, Score } from './music';
import { fineModels, GLYPH } from './units';
import { grime, loadModels } from './models';

// ---------- renderer ----------
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
const world = new World(scene, renderer);
fx.init(scene);
scars.init(scene);
rig.init(canvas);
world.cam = rig.cam;
world.onThunder = (d) => sfx.thunder(d);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, rig.cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.7, 0.95);
composer.addPass(bloom);
// Final grade: cinematic tilt-shift depth blur, chromatic fringe on impacts, desaturation and vignette.
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTilt: { value: 0 }, uDesat: { value: 0 }, uAb: { value: 0 }, uImpact: { value: 0 }, uTint: { value: new THREE.Color() }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTilt, uDesat, uAb, uImpact; uniform vec3 uTint; uniform vec2 uRes; varying vec2 vUv;
    void main(){
      vec2 uv=vUv, d=uv-0.5; vec3 col;
      float r=uTilt*smoothstep(0.1,0.5,abs(d.y))*7.0;
      if(r>0.4){ col=vec3(0.0);
        for(int i=-3;i<=3;i++) for(int j=-3;j<=3;j++) col+=texture2D(tDiffuse,uv+vec2(float(i),float(j))*r/(3.0*uRes)).rgb;
        col/=49.0;
      } else col=texture2D(tDiffuse,uv).rgb;
      if(uAb>0.001){ float a=uAb*dot(d,d)*0.12; col.r=texture2D(tDiffuse,uv+d*a).r; col.b=texture2D(tDiffuse,uv-d*a).b; }
      float l=dot(col,vec3(0.299,0.587,0.114));
      col=mix(col,vec3(l)*vec3(1.08,0.94,0.86),uDesat);
      if(uImpact>0.01){ // impact frame: two-tone ink in the attacker's colour, with radial speed lines
        vec3 ink=mix(vec3(0.015,0.015,0.03),uTint*1.25+0.1,smoothstep(0.42,0.75,l));
        float ang=atan(d.y,d.x), ln=step(0.87,fract(sin(floor(ang*84.0))*43758.5453))*smoothstep(0.24,0.6,length(d));
        col=mix(col,ink+ln*0.9,uImpact*0.9);
      }
      col*=mix(0.42,1.0,smoothstep(0.95,0.32,length(d*vec2(1.0,0.86))));
      gl_FragColor=vec4(col,1.0);
    }`,
});
composer.addPass(grade);
composer.addPass(new OutputPass());
const post = { tilt: 0, desat: 0 }; // targets, smoothed per frame

function resize() {
  const w = window.innerWidth, h = window.innerHeight, pr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  composer.setPixelRatio(pr); composer.setSize(w, h);
  grade.uniforms.uRes.value.set(w * pr, h * pr);
  rig.setAspect(w / h);
  fx.setViewport(h * pr, rig.cam.fov);
}
window.addEventListener('resize', resize);
resize();

// ---------- markers ----------
const mk = (geo: THREE.BufferGeometry, color: number, opacity = 1) => {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.renderOrder = 4; m.visible = false; scene.add(m);
  return m;
};
const flat = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);
const moveGeo = flat(new THREE.RingGeometry(0.3, 0.42, 36)), dotGeo = flat(new THREE.CircleGeometry(0.13, 20));
const capGeo = flat(new THREE.RingGeometry(0.98, 1.2, 4)), sqGeo = flat(new THREE.RingGeometry(0.9, 0.98, 4));
const targets = Array.from({ length: 20 }, () => ({ ring: mk(moveGeo, 0xffd070), dot: mk(dotGeo, 0xffffff, 0.9), cap: mk(capGeo, 0xff3020), sq: -1 }));
// Target markers draw over units so a ring directly behind the selected piece stays visible.
for (const t of targets) for (const m of [t.ring, t.dot, t.cap]) { m.material.depthTest = false; m.renderOrder = 25; }
const lastMarks = [mk(sqGeo, 0xffc060, 0.5), mk(sqGeo, 0xffc060, 0.8)];
const beamTex = (() => {
  const c = document.createElement('canvas'); c.width = 4; c.height = 128;
  const g = c.getContext('2d')!, gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0.75)');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
})();
const beam = mk(new THREE.CylinderGeometry(0.78, 0.78, 3.4, 32, 1, true).translate(0, 1.7, 0), 0xffffff, 0.5);
beam.material.map = beamTex;
const hoverRing = mk(flat(new THREE.RingGeometry(0.78, 0.86, 40)), 0xffffff, 0.7);

// ---------- game state ----------
const engine = new Engine();
const units = new Map<number, Unit>();
const opts = { autoCam: true, badges: true };
const capIds = new Set<number>();
let selected = -1, legal: number[] = [], busy = false, over = false, checkId = -1, generation = 0;
let rebuildQueued = false;
let mode: Mode = 'pvp', thinking = false, progress = 0, inCheckNow = false, weatherLock = false;
/** Is this side played by the computer in the current mode? */
const isAI = (s: Side) => mode === 'watch' || (mode === 'pve' && s === 'b');

// ---------- AI (search runs in a worker) ----------
const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
const waiting = new Map<number, (r: AiResult | null) => void>();
let reqId = 0, aiEpoch = 0;
worker.onmessage = (e: MessageEvent<{ id: number; res: AiResult | null }>) => { waiting.get(e.data.id)?.(e.data.res); waiting.delete(e.data.id); };
worker.onerror = () => { for (const r of waiting.values()) r(null); waiting.clear(); };
function askAI(): Promise<AiResult | null> {
  const req: AiRequest = {
    board: encode(engine.board), turn: engine.turn === 'r' ? 0 : 1, reps: engine.keys.slice(0, -1).map(hashKey),
    timeMs: mode === 'watch' ? 600 : 1000, variety: engine.history.length < 4,
  };
  return new Promise((res) => { const id = ++reqId; waiting.set(id, res); worker.postMessage({ id, req }); });
}
/** Let the computer move if it is its turn. `ready` is a search already started during the previous animation. */
async function aiTurn(ready?: Promise<AiResult | null>) {
  if (over || busy || !isAI(engine.turn)) return;
  const gen = generation, ply = engine.history.length, ep = ++aiEpoch;
  thinking = true; refresh();
  const r = await (ready ?? askAI());
  await wait(mode === 'watch' ? 0.35 : 0.2);
  if (gen !== generation || ply !== engine.history.length || ep !== aiEpoch) return; // superseded by undo / restart / a newer request
  thinking = false;
  if (busy || over || !isAI(engine.turn)) { refresh(); return; }
  let mv = r && engine.legalFrom(r.from).includes(r.to) ? r : null;
  if (!mv) { const all = engine.legalMoves(); mv = all.length ? { ...all[(Math.random() * all.length) | 0], score: 0, depth: 0, nodes: 0 } : null; } // never stall
  if (mv) void play(mv.from, mv.to);
}

function sync() {
  for (const u of units.values()) u.dispose();
  units.clear(); fx.clearDebris();
  engine.board.forEach((p, i) => { if (p) { const u = new Unit(p, i, scene); u.badge.visible = opts.badges; units.set(p.id, u); } });
  refresh();
}

/** Spectator games are capped so two evenly matched engines cannot shuffle forever. */
const WATCH_PLY_LIMIT = 220;
function refresh() {
  let st = engine.status();
  if (mode === 'watch' && !st.over && engine.history.length >= WATCH_PLY_LIMIT) st = { ...st, over: true, winner: null, reason: 'nocapture' };
  const ks = st.check ? engine.kingSquare(engine.turn) : -1;
  checkId = ks >= 0 ? engine.board[ks]!.id : -1;
  hud.setTurn(over ? (st.winner ?? engine.turn) : engine.turn, st.check, over, thinking && !over);
  hud.setHistory(engine.history);
  // Weather is a pure function of the game: the day wears on as pieces fall, checks bring the storm.
  const caps = engine.history.reduce((n, m) => n + (m.captured ? 1 : 0), 0);
  progress = Math.min(1, Math.max(caps / 18, engine.history.length / 110));
  inCheckNow = st.check && !st.over;
  if (!weatherLock) world.setMood(progress, st.over ? 0.75 : st.check ? 1 : 0, st.over ? 1 : st.check ? 0.3 : 0);
  const last = engine.history.at(-1);
  lastMarks.forEach((m, i) => {
    m.visible = !!last;
    if (last) { sqPos(i ? last.to : last.from, m.position); m.position.y += 0.04; m.rotation.y = Math.PI / 4; }
  });
  return st;
}

function select(i: number) {
  selected = i; legal = i >= 0 ? engine.legalFrom(i) : [];
  capIds.clear();
  for (const to of legal) { const q = engine.board[to]; if (q) capIds.add(q.id); }
  targets.forEach((t, k) => {
    const to = legal[k], on = to !== undefined, cap = on && !!engine.board[to];
    t.sq = on ? to : -1;
    t.ring.visible = t.dot.visible = on && !cap; t.cap.visible = cap;
    if (on) for (const m of [t.ring, t.dot, t.cap]) { sqPos(to, m.position); m.position.y = Math.max(m.position.y, -0.18) + 0.05; }
  });
  beam.visible = i >= 0;
  if (i >= 0) {
    const u = units.get(engine.board[i]!.id)!;
    beam.position.copy(u.root.position); beam.material.color.set(TEAM[u.piece.side].glow);
    tween(0.28, (t) => { u.body.position.y = Math.sin(Math.PI * t) * 0.22; });
  }
}

async function play(from: number, to: number): Promise<boolean> {
  if (busy || over) return false;
  const m = engine.move(from, to);
  if (!m) { sfx.error(); return false; }
  scars.ply = engine.history.length;
  busy = true; thinking = false; select(-1); hoverRing.visible = false;
  // Start the reply search now so it runs while the move animates.
  const next = isAI(engine.turn) && !engine.status().over ? askAI() : undefined;
  if (mode === 'watch') rig.glance(sqPos(to));
  const gen = generation;
  const u = units.get(m.piece.id)!, toPos = sqPos(to);
  if (m.captured) {
    const v = units.get(m.captured.id)!;
    units.delete(m.captured.id);
    rig.cineStart(u.root.position, toPos); hud.cinematic(true); post.tilt = 1;
    const key = m.piece.type + m.captured.type;
    hud.duel(DUEL[key] ?? '短兵相接', GLYPH[m.piece.side][m.piece.type], GLYPH[m.captured.side][m.captured.type], m.piece.side);
    void playBrace(v, u.root.position);
    await wait(0.65);
    let death: Promise<void> = Promise.resolve();
    await playAttack(u, toPos, m.captured.type, (dir, kind) => {
      // Hit-stop, then bullet time while the camera swings around the impact.
      slowmo(0.03, 0.13, [0.22, 0.65]); rig.shake(kind === 'blade' ? 0.45 : 0.3); rig.cineOrbit(0.75, 0.8);
      music.hit();
      grade.uniforms.uAb.value = 1; grade.uniforms.uImpact.value = 1; grade.uniforms.uTint.value.set(TEAM[u.piece.side].glow);
      fx.sparks(new THREE.Vector3(toPos.x, toPos.y + 0.9, toPos.z), dir, 30, TEAM[u.piece.side].glow, 9);
      fx.flash(toPos, TEAM[u.piece.side].glow, 45, 0.35);
      death = playDeath(v, dir, kind);
      rig.cineFollow(v.root.position);
    });
    await death;
    await wait(0.2);
    rig.cineEnd(); hud.cinematic(false); hud.duelHide(); post.tilt = 0;
  } else {
    await playMove(u, toPos);
  }
  if (gen !== generation) return true;
  u.sq = to;
  const st = refresh();
  if (st.over) await finale(st, u);
  else {
    if (st.check) {
      hud.flash('將軍', m.piece.side); sfx.check(); rig.shake(0.25); world.strike(rig.cam);
      if (mode === 'watch') rig.focus(sqPos(engine.kingSquare(engine.turn)), 1.6);
    }
    if (opts.autoCam && mode === 'pvp') rig.faceSide(engine.turn);
  }
  busy = false;
  if (rebuildQueued) { rebuildQueued = false; sync(); }
  if (!over) void aiTurn(next);
  return true;
}

async function finale(st: Status, by: Unit) {
  over = true;
  const gen = generation;
  if (st.reason !== 'checkmate' && st.reason !== 'stalemate') {
    // Draws and perpetual check end without a king falling.
    hud.flash(st.winner ? '長將' : '和棋', st.winner ?? engine.turn); sfx.gong();
    await wait(1.6);
    if (gen !== generation) return;
    refresh();
    hud.gameOver(st.winner, st.reason === 'perpetual' ? '长将判负' : st.reason === 'repetition' ? '三次重复' : '久战无果');
    void autoRestart(gen);
    return;
  }
  const loser = engine.turn, ks = engine.kingSquare(loser), king = units.get(engine.board[ks]!.id)!;
  hud.flash(st.reason === 'checkmate' ? '絕殺' : '困斃', st.winner!); sfx.check();
  await wait(0.7);
  rig.cineStart(by.root.position.distanceTo(king.root.position) > 0.5 ? by.root.position : new THREE.Vector3(0, 0, 0), king.root.position, 0.8);
  hud.cinematic(true); post.tilt = 1;
  await wait(0.9);
  slowmo(0.5, 1.2);
  post.desat = 0.8;
  await playDeath(king, new THREE.Vector3(0, 0, loser === 'r' ? 1 : -1), 'blade');
  sfx.victory();
  for (const u of units.values()) if (u.piece.side === st.winner) { fx.embers(u.root.position, 14, TEAM[st.winner!].glow, 0.5, 2.5); tween(0.5, (t) => { u.body.position.y = Math.sin(Math.PI * t) * 0.35; }); }
  await wait(0.8);
  rig.cineEnd(); hud.cinematic(false); post.tilt = 0;
  if (gen !== generation) return;
  refresh();
  hud.gameOver(st.winner!, st.reason === 'checkmate' ? '绝 杀' : '困 毙');
  void autoRestart(gen);
}
/** In spectator mode the armies reset and go again after a pause over the aftermath. */
async function autoRestart(gen: number) {
  if (mode !== 'watch') return;
  rig.wide();
  await wait(9);
  if (gen === generation && mode === 'watch') restart(true);
}

function resetState() {
  generation++;
  over = false; busy = false; post.desat = 0; post.tilt = 0;
  rig.cineEnd(); hud.cinematic(false); hud.hideOver(); hud.duelHide();
  grade.uniforms.uImpact.value = 0;
  scars.rewind(engine.history.length);
  thinking = false;
  select(-1); sync();
  if (opts.autoCam && mode === 'pvp') rig.faceSide(engine.turn);
  if (!over) void aiTurn();
}
function setMode(m: Mode) {
  mode = m; hud.setMode(m);
  rig.director = m === 'watch';
  if (m !== 'watch') rig.reset(m === 'pve' ? 'r' : engine.turn);
  thinking = false;
  if (!busy) { refresh(); if (!over) void aiTurn(); else void autoRestart(generation); }
}
function undo() {
  if (busy || mode === 'watch') { sfx.error(); return; }
  if (!engine.undo()) { sfx.error(); return; }
  // Against the computer, also take back its reply so it is the human's turn again.
  if (mode === 'pve' && isAI(engine.turn) && engine.history.length) engine.undo();
  sfx.place(); resetState();
}
function restart(auto = false) {
  if (busy && !auto) return;
  engine.load(START_FEN); sfx.drum(); resetState();
  if (mode !== 'watch') rig.reset('r');
}

// ---------- input ----------
const ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
function pickSquare(ndc: THREE.Vector2): number {
  ray.setFromCamera(ndc, rig.cam);
  const picks: THREE.Object3D[] = [];
  for (const u of units.values()) if (!u.dead) picks.push(u.pick);
  const hit = ray.intersectObjects(picks, false)[0];
  const h = hit ? (hit.object.userData.unit as Unit).sq : -1;
  let g = -1, gd = 0.85;
  if (ray.ray.intersectPlane(ground, hitP))
    for (let i = 0; i < 90; i++) { const d = Math.hypot(colX(i % 9) - hitP.x, rowZ((i / 9) | 0) - hitP.z); if (d < gd) { gd = d; g = i; } }
  if (selected >= 0) {
    // A tall unit in front must not swallow clicks meant for a legal square behind it.
    if (h >= 0 && legal.includes(h)) return h;
    if (g >= 0 && legal.includes(g) && (h < 0 || h === selected || engine.board[h]?.side !== engine.turn || gd < 0.5)) return g;
  }
  return h >= 0 ? h : g;
}

rig.onClick = (ndc) => {
  sfx.unlock();
  if (busy || over || isAI(engine.turn)) return;
  const i = pickSquare(ndc);
  if (i < 0) { select(-1); return; }
  const p = engine.board[i];
  if (selected >= 0 && legal.includes(i)) void play(selected, i);
  else if (p && p.side === engine.turn) { if (i !== selected) { sfx.select(); select(i); } }
  else { if (selected >= 0 || p) sfx.error(); select(-1); }
};
rig.onHover = (ndc) => {
  if (busy || over || isAI(engine.turn)) { canvas.classList.remove('pointing'); hoverRing.visible = false; return; }
  const i = pickSquare(ndc), p = i >= 0 ? engine.board[i] : null;
  const can = i >= 0 && ((p && p.side === engine.turn) || legal.includes(i));
  canvas.classList.toggle('pointing', !!can);
  hoverRing.visible = !!can && i !== selected;
  if (can) { sqPos(i, hoverRing.position); hoverRing.position.y = Math.max(hoverRing.position.y, -0.18) + 0.06; }
};
rig.onDoubleTap = () => rig.reset(engine.turn);
window.addEventListener('keydown', () => sfx.unlock(), { once: true });
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

hud.init({
  reset: () => rig.reset(engine.turn),
  undo, restart: () => restart(), mode: setMode,
  autoCam: (on) => { opts.autoCam = on; if (on && mode === 'pvp') rig.faceSide(engine.turn); },
  badges: (on) => { opts.badges = on; for (const u of units.values()) u.badge.visible = on && !u.busy; },
  sound: (on) => { sfx.unlock(); sfx.setMuted(!on); },
  music: (on) => { sfx.unlock(); music.setOn(on); },
  fine: (on) => { fineModels.on = on; if (busy) rebuildQueued = true; else { select(-1); sync(); } }, // mid-move: rebuild as soon as it ends
});

// ---------- main loop ----------
function step(realDt: number) {
  tick(realDt);
  const t = clock.time, dt = clock.dt;
  timeU.value = t;
  world.quiet = rig.cinematic || grade.uniforms.uImpact.value > 0.02;
  world.update(t, dt, rig.focusPoint);
  renderer.toneMappingExposure = world.exposure;
  sfx.setRain(world.mood.rain);
  music.tension = over ? 0.05 : Math.min(1, 0.12 + 0.5 * progress + (inCheckNow ? 0.3 : 0) + (rig.cinematic ? 0.45 : 0));
  music.tick();
  grime.value += (progress - grime.value) * Math.min(1, dt * 0.5);
  for (const u of units.values()) {
    u.idle(t, dt);
    const sel = u.sq === selected && !busy, chk = u.piece.id === checkId;
    const tgt = capIds.has(u.piece.id) && !busy;
    u.ring.material.opacity = sel || tgt ? 1 : chk ? 0.6 + 0.4 * Math.sin(t * 9) : 0.42;
    u.ring.material.color.set(chk || tgt ? 0xff2010 : TEAM[u.piece.side].glow);
    u.ring.scale.setScalar(sel ? 1.12 + 0.06 * Math.sin(t * 6) : tgt ? 1.25 + 0.1 * Math.sin(t * 8) : chk ? 1.2 : 1);
    u.ring.position.y = 0.035 + Math.max(0, -0.16 - groundHeight(u.root.position.x, u.root.position.z));
  }
  const pulse = 0.5 + 0.5 * Math.sin(t * 5);
  for (const m of targets) {
    if (m.sq < 0) continue;
    m.ring.scale.setScalar(0.9 + 0.2 * pulse); m.ring.material.opacity = 0.65 + 0.35 * pulse;
    m.cap.rotation.y = t * 1.6; m.cap.scale.setScalar(0.95 + 0.12 * pulse);
  }
  beam.material.opacity = 0.32 + 0.14 * pulse; beam.rotation.y = t;
  fx.update(dt); scars.update(dt);
  rig.update(realDt);
  const k = 1 - Math.exp(-realDt * 6), gu = grade.uniforms;
  gu.uTilt.value = lerp(gu.uTilt.value, post.tilt, k);
  gu.uDesat.value = lerp(gu.uDesat.value, post.desat, k * 0.4);
  gu.uAb.value = Math.max(0, gu.uAb.value - realDt * 2.5);
  gu.uImpact.value = Math.max(0, gu.uImpact.value - realDt * 8);
  composer.render();
}

let last = performance.now(), manual = false; // manual: only __game.advance() steps the simulation
function frame(now: number) {
  if (!manual) step(Math.min(0.05, (now - last) / 1000));
  last = now;
  requestAnimationFrame(frame);
}

await loadModels(); // authored models must be ready before the first units are built
sync();
world.setMood(0, 0, 0, true); // open at dawn rather than easing there from the default dusk
rig.reset('r');
requestAnimationFrame(frame);

// ---------- debug / test hook ----------
const yieldTask = () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
(window as any).__game = {
  engine, units, rig, clock, fx, scars, scene, renderer, grade: grade.uniforms, world, music, Score, grime,
  /** Pin the weather for testing: weather(time, storm, rain), or weather() to follow the game again. */
  weather(time?: number, storm = 0, rain = 0) { weatherLock = time !== undefined; if (weatherLock) world.setMood(time!, storm, rain, true); else refresh(); },
  get state() { return { turn: engine.turn as Side, busy, over, selected, mode, thinking, history: engine.history.map((m) => m.notation), status: engine.status() }; },
  set timeScale(v: number) { clock.userScale = v; },
  set manual(v: boolean) { manual = v; },
  /** Switch between authored models and the original procedural ones (rebuilds every unit). */
  fine(on: boolean) { if (busy) return false; fineModels.on = on; select(-1); sync(); return true; },
  load(fen: string) { engine.load(fen); resetState(); },
  move(s: string) { return play(sq(s.slice(0, 2)), sq(s.slice(2, 4))); },
  click(s: string) { const i = sq(s), p = engine.board[i]; if (selected >= 0 && legal.includes(i)) return play(selected, i); if (p && p.side === engine.turn) select(i); return legal.map(sqName); },
  undo, restart, setMode,
  /** Drive the simulation manually (for hidden tabs where rAF is paused). */
  async advance(seconds: number, fps = 30) { for (let i = 0; i < seconds * fps; i++) { step(1 / fps); await yieldTask(); } },
};
void ease;
