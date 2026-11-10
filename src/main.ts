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
import { encode, hashKey, STYLES, type AiRequest, type AiResult, type Style } from './ai';
import { bookMoves, openingName } from './book';
import { SIDE_NAME, STYLE_NAME, judge, line, sacrificed, taken, type Moment } from './commentary';
import { music, Score } from './music';
import { fineModels, GLYPH } from './units';
import { grime, loadModels } from './models';
import { quality, type Settings } from './quality';
import { decode, encode as encodeRecord, resultText, startFen, toText, type Ply } from './record';
import { highlights, type Clip } from './reel';
import { Recorder, canRecord, type Caption, type Overlay, type Recording } from './capture';
import { CLASSICS, classicRecord, type Classic } from './classics';
import { traditional } from './notation';

// ---------- renderer ----------
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.s.dpr));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = quality.s.shadowType;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
const world = new World(scene, renderer);
fx.init(scene);
scars.init(scene);
rig.init(canvas);
world.cam = rig.cam;
world.onThunder = (d) => sfx.thunder(d);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality.s.msaa }));
composer.addPass(new RenderPass(scene, rig.cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.7, 0.95);
composer.addPass(bloom);
const bloomSize = bloom.setSize.bind(bloom), bs = (v: number) => Math.max(1, Math.round(v * (quality.s.bloom || 1)));
bloom.setSize = (w, h) => bloomSize(bs(w), bs(h)); // lower tiers blur a smaller copy of the frame
bloom.enabled = quality.s.bloom > 0;
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

/** While a video is recorded the frame is rendered at a fixed size: at least 1280 on its long side
 *  (more if the tier already renders more), at most 1920 x 1080, both even for the encoder. */
let capturing = false;
function resize() {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  let pr = Math.min(window.devicePixelRatio, quality.s.dpr), W = w * pr, H = h * pr;
  if (capturing) {
    const L = Math.max(w, h), S = Math.min(w, h), k = Math.min(1920 / L, 1080 / S, Math.max(pr, 1280 / L));
    W = 2 * Math.round((w * k) / 2); H = 2 * Math.round((h * k) / 2); pr = 1;
  }
  renderer.setPixelRatio(pr); renderer.setSize(capturing ? W : w, capturing ? H : h, false);
  composer.setPixelRatio(pr); composer.setSize(capturing ? W : w, capturing ? H : h);
  grade.uniforms.uRes.value.set(W, H);
  rig.setAspect(w / h);
  fx.setViewport(H, rig.cam.fov);
}
window.addEventListener('resize', resize);
resize();
/** Render side of a quality switch: pixel ratio, shadow filtering, MSAA and bloom. */
function applyQuality(s: Settings) {
  renderer.shadowMap.type = s.shadowType; bloom.enabled = s.bloom > 0;
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== s.msaa) { rt.samples = s.msaa; rt.dispose(); }
  resize();
}

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

// ---------- overlays ----------
// The DOM shows titles and the letterbox; a recording copies them into the video (see capture.ts).
const burn: Overlay = { time: 0, letterbox: false, card: null, banner: null, duel: null };
const caption = (text: string, side: Caption['side'], life: number, sub?: string): Caption => ({ text, sub, side, t: clock.real, life });
function flash(text: string, side: Side) { hud.flash(text, side); burn.banner = caption(text, side, 1.5); }
function cinematic(on: boolean) { hud.cinematic(on); burn.letterbox = on; }

// ---------- game state ----------
const engine = new Engine();
const units = new Map<number, Unit>();
const opts = { autoCam: true, badges: true };
const capIds = new Set<number>();
let selected = -1, legal: number[] = [], busy = false, over = false, checkId = -1, generation = 0;
let rebuildQueued = false;
let mode: Mode = 'pvp', thinking = false, progress = 0, inCheckNow = false, weatherLock = false;
/** Is this side played by the computer in the current mode? */
const isAI = (s: Side) => !rp && (mode === 'watch' || (mode === 'pve' && s === 'b'));
/** Replay of a recorded game. `back` is the live game to return to; `token` invalidates stale autoplay timers. */
interface Replay { fen: string; moves: Ply[]; code: string; back: { fen: string; moves: Ply[] }; playing: boolean; speed: number; token: number; /** a classic from the manuals: its moves are captioned */ classic?: Classic }
let rp: Replay | null = null;

// ---------- AI (search runs in a worker) ----------
const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
const waiting = new Map<number, (r: AiResult | null) => void>();
let reqId = 0, aiEpoch = 0;
worker.onmessage = (e: MessageEvent<{ id: number; res: AiResult | null }>) => { waiting.get(e.data.id)?.(e.data.res); waiting.delete(e.data.id); };
worker.onerror = () => { for (const r of waiting.values()) r(null); waiting.clear(); };
/** A request in flight, tagged with the style generation it was asked under. */
type Ask = Promise<AiResult | null> & { sg?: number };
function askAI(): Ask {
  const req: AiRequest = {
    board: encode(engine.board), turn: engine.turn === 'r' ? 0 : 1, reps: engine.keys.slice(0, -1).map(hashKey),
    timeMs: mode === 'watch' ? 600 : 1000, variety: engine.history.length < 4,
    style: styles[engine.turn], book: engine.history.length < 24 && startFen(engine) === START_FEN,
  };
  const p: Ask = new Promise((res) => { const id = ++reqId; waiting.set(id, res); worker.postMessage({ id, req }); });
  p.sg = styleGen;
  return p;
}
/** Let the computer move if it is its turn. `ready` is a search already started during the previous animation. */
async function aiTurn(ready?: Ask) {
  if (over || busy || !isAI(engine.turn)) return;
  const gen = generation, ply = engine.history.length, ep = ++aiEpoch;
  thinking = true; refresh();
  const r = await (ready && ready.sg === styleGen ? ready : askAI()); // a style change voids the prefetch
  await wait(mode === 'watch' ? 0.35 : 0.2);
  if (gen !== generation || ply !== engine.history.length || ep !== aiEpoch) return; // superseded by undo / restart / a newer request
  thinking = false;
  if (busy || over || !isAI(engine.turn)) { refresh(); return; }
  let mv = r && engine.legalFrom(r.from).includes(r.to) ? r : null;
  if (!mv) { const all = engine.legalMoves(); mv = all.length ? { ...all[(Math.random() * all.length) | 0], score: 0, depth: 0, nodes: 0 } : null; } // never stall
  if (!mv) return;
  const side = engine.turn, done = play(mv.from, mv.to);
  if (mv === r) noteAI(side, r, done);
}

// ---------- styles and commentary ----------
// Each computer side has a style (pve: black's, cycled by tapping 人机 again; watch: a random pairing
// each game, re-rolled by tapping 观战). A change applies from the next AI move: requests carry their
// style generation and a stale prefetch is asked again. Commentary is one caption after the move:
// the book opening's name once per side, else a notable moment, at most one every few plies.
const styles: Record<Side, Style> = { r: 'balanced', b: 'balanced' };
let styleGen = 0, pveStyle: Style = 'balanced'; // pve keeps its own choice across spectator games
/** The computer's last move: the search's verdict, or a book move. */
let lastAi: { side: Side; move: string; score: number; depth: number; book: boolean; style: Style; opening: string | null } | null = null;
const fresh = () => ({ ply: -99, named: { r: false, b: false }, told: { r: new Set<Moment>(), b: new Set<Moment>() }, prev: { r: null as number | null, b: null as number | null } });
let talk = fresh();
function styleChanged() {
  styleGen++;
  if (thinking && !busy) { thinking = false; void aiTurn(); } // re-ask now; the old answer is discarded by the epoch guard
}
/** A fresh random pairing for spectator mode; `now` also re-asks a search already running. */
function rollPairing(now = true) {
  const r = STYLES[(Math.random() * 3) | 0], others = STYLES.filter((s) => s !== r);
  styles.r = r; styles.b = others[(Math.random() * 2) | 0];
  hud.reelCard(`${STYLE_NAME[styles.r]} 对 ${STYLE_NAME[styles.b]}`, '红方 · 黑方', 'd', 2.6);
  if (now) styleChanged(); else styleGen++;
}
function cycleStyle() {
  if (mode === 'watch') { rollPairing(); return; }
  styles.b = pveStyle = STYLES[(STYLES.indexOf(styles.b) + 1) % STYLES.length];
  hud.toast(`黑方棋风 · ${STYLE_NAME[styles.b]}`); styleChanged();
}
function noteAI(side: Side, r: AiResult, done: Promise<boolean>) {
  const gen = generation, ply = engine.history.length, style = styles[side];
  const opening = r.book ? openingName(engine.history.map((m) => sqName(m.from) + sqName(m.to)), side) : null;
  lastAi = { side, move: sqName(r.from) + sqName(r.to), score: r.score, depth: r.depth, book: !!r.book, style, opening };
  let text = '';
  if (opening && !talk.named[side]) { talk.named[side] = true; text = opening; }
  else if (!r.book && (r.depth >= 4 || Math.abs(r.score) > 29800)) { // a shallow verdict (a forced reply) says little
    const m = judge({ score: r.score, prev: talk.prev[side], given: sacrificed(engine), taken: taken(engine), since: ply - talk.ply }, talk.told[side]);
    if (m) { talk.told[side].add(m); text = line(m, style, r.score); }
    talk.prev[side] = r.score;
  }
  if (!text) return;
  talk.ply = ply;
  void done.then((ok) => { if (ok && gen === generation && !rp && !reel && !over && engine.history.length === ply) hud.remark(text, `${SIDE_NAME[side]} · ${STYLE_NAME[style]}`, side); });
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
  if (mode === 'watch' && !rp && !st.over && engine.history.length >= WATCH_PLY_LIMIT) st = { ...st, over: true, winner: null, reason: 'nocapture' };
  const ks = st.check ? engine.kingSquare(engine.turn) : -1;
  checkId = ks >= 0 ? engine.board[ks]!.id : -1;
  hud.setTurn(over ? (st.winner ?? engine.turn) : engine.turn, st.check, over, thinking && !over);
  hud.setHistory(engine.history);
  if (rp) hud.replayState(engine.history.length, rp.moves.length, rp.playing, rp.speed, st.over ? resultText(st) : '');
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
  if (mode === 'watch' || rp) rig.glance(sqPos(to));
  const gen = generation;
  const u = units.get(m.piece.id)!, toPos = sqPos(to);
  if (m.captured) {
    const v = units.get(m.captured.id)!;
    units.delete(m.captured.id);
    rig.cineStart(u.root.position, toPos); cinematic(true); post.tilt = 1;
    const key = m.piece.type + m.captured.type;
    hud.duel(DUEL[key] ?? '短兵相接', GLYPH[m.piece.side][m.piece.type], GLYPH[m.captured.side][m.captured.type], m.piece.side);
    burn.duel = caption(DUEL[key] ?? '短兵相接', m.piece.side, 2.7);
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
    rig.cineEnd(); cinematic(false); hud.duelHide(); burn.duel = null; post.tilt = 0;
  } else {
    await playMove(u, toPos);
  }
  if (gen !== generation) return true;
  u.sq = to;
  const st = refresh();
  if (st.over) await finale(st, u);
  else {
    if (st.check) {
      flash('將軍', m.piece.side); sfx.check(); rig.shake(0.25); world.strike(rig.cam);
      if (mode === 'watch' || rp) rig.focus(sqPos(engine.kingSquare(engine.turn)), 1.6);
    }
    if (opts.autoCam && mode === 'pvp' && !rp) rig.faceSide(engine.turn);
  }
  busy = false;
  if (rebuildQueued) { rebuildQueued = false; sync(); }
  if (queued) { const f = queued; queued = null; hurry(false); f(); return true; }
  if (rp) { replayed(); return true; }
  if (!over) void aiTurn(next);
  return true;
}

async function finale(st: Status, by: Unit) {
  over = true;
  const gen = generation;
  if (st.reason !== 'checkmate' && st.reason !== 'stalemate') {
    // Draws and perpetual check end without a king falling.
    flash(st.winner ? '長將' : '和棋', st.winner ?? engine.turn); sfx.gong();
    await wait(1.6);
    if (gen !== generation) return;
    refresh();
    if (!rp) showOver(st);
    return;
  }
  const loser = engine.turn, ks = engine.kingSquare(loser), king = units.get(engine.board[ks]!.id)!;
  flash(st.reason === 'checkmate' ? '絕殺' : '困斃', st.winner!); sfx.check();
  await wait(0.7);
  rig.cineStart(by.root.position.distanceTo(king.root.position) > 0.5 ? by.root.position : new THREE.Vector3(0, 0, 0), king.root.position, 0.8);
  cinematic(true); post.tilt = 1;
  await wait(0.9);
  slowmo(0.5, 1.2);
  post.desat = 0.8;
  await playDeath(king, new THREE.Vector3(0, 0, loser === 'r' ? 1 : -1), 'blade');
  sfx.victory();
  for (const u of units.values()) if (u.piece.side === st.winner) { fx.embers(u.root.position, 14, TEAM[st.winner!].glow, 0.5, 2.5); tween(0.5, (t) => { u.body.position.y = Math.sin(Math.PI * t) * 0.35; }); }
  await wait(0.8);
  rig.cineEnd(); cinematic(false); post.tilt = 0;
  if (gen !== generation) return;
  refresh();
  if (!rp) showOver(st);
}
const OVER_SUB: Record<string, string> = { checkmate: '绝 杀', stalemate: '困 毙', perpetual: '长将判负', repetition: '三次重复', nocapture: '久战无果' };
function showOver(st: Status) { hud.gameOver(st.winner, OVER_SUB[st.reason ?? 'nocapture']); void autoRestart(generation); }
/** In spectator mode the armies reset and go again after a pause over the aftermath. */
async function autoRestart(gen: number) {
  if (mode !== 'watch' || rp) return;
  rig.wide();
  await wait(9);
  if (gen === generation && mode === 'watch' && !rp) restart(true);
}

function resetState() {
  generation++;
  over = engine.status().over; busy = false; post.desat = 0; post.tilt = 0;
  rig.cineEnd(); cinematic(false); hud.hideOver(); hud.duelHide(); burn.duel = burn.banner = null;
  grade.uniforms.uImpact.value = 0;
  scars.rewind(engine.history.length);
  thinking = false; lastAi = null; talk = fresh(); hud.remark('', '', 'r');
  select(-1); sync();
  if (opts.autoCam && mode === 'pvp' && !rp) rig.faceSide(engine.turn);
  if (!over) void aiTurn();
}
function setMode(m: Mode) {
  const was = mode;
  mode = m; hud.setMode(m);
  if (m === 'watch' && was !== 'watch' && !rp) rollPairing(false);
  if (m === 'pve' && styles.b !== pveStyle) { styles.b = pveStyle; styleGen++; }
  rig.director = m === 'watch' || !!rp?.playing;
  if (m !== 'watch' && !rp) rig.reset(m === 'pve' ? 'r' : engine.turn);
  thinking = false;
  if (!busy) { refresh(); if (!over) void aiTurn(); else void autoRestart(generation); }
}
function undo() {
  if (reel) return;
  if (rp) { replayPrev(); return; }
  if (busy || mode === 'watch') { sfx.error(); return; }
  if (!engine.undo()) { sfx.error(); return; }
  // Against the computer, also take back its reply so it is the human's turn again.
  if (mode === 'pve' && isAI(engine.turn) && engine.history.length) engine.undo();
  sfx.place(); resetState();
}
function restart(auto = false) {
  if (reel && auto) return;
  if (rp) { const r = rp; whenIdle(() => { if (rp !== r) return; leaveReplay(); restart(); }); return; }
  if (busy && !auto) return;
  engine.load(START_FEN); sfx.drum();
  if (mode === 'watch') rollPairing(false);
  resetState();
  if (mode !== 'watch') rig.reset('r');
}

// ---------- replay ----------
// Replay drives the same engine and play() as a live game. Forward steps animate the real move; back
// steps and scrubbing rebuild the position instantly through resetState(), which also rolls the scars
// back to the ply shown. Nothing interrupts a running move: requests made during one are queued (the
// latest wins) and the move is hurried along to make room.
let queued: (() => void) | null = null, baseScale = 1;
function whenIdle(fn: () => void) { if (!busy) { fn(); return; } queued = fn; hurry(true); }
function hurry(on: boolean) { clock.userScale = on ? Math.max(8, rp?.speed ?? 1) : rp ? rp.speed : baseScale; }
const plies = (e: Engine) => e.history.map((m) => ({ from: m.from, to: m.to }));
/** Set the engine to `fen` followed by `moves` without animation. */
function rebuild(fen: string, moves: Ply[]) { engine.load(fen); for (const m of moves) engine.move(m.from, m.to); }
/** Enter replay of `text` (a record or link), or of the game on screen. Returns false for a bad record. */
function enterReplay(text?: string): boolean {
  if (text === undefined && rp) return true;
  let rec: { fen: string; moves: Ply[]; code: string };
  try {
    if (text === undefined) rec = { fen: startFen(engine), moves: plies(engine), code: encodeRecord(engine) };
    else { const d = decode(text); rec = { fen: d.fen, moves: d.moves, code: encodeRecord(d.engine) }; }
  } catch (e) {
    console.warn('Bad game record:', e instanceof Error ? e.message : e);
    hud.toast('棋谱无效'); sfx.error(); return false;
  }
  if (!rp && !queued) baseScale = clock.userScale; // before any hurrying
  // A link starts at the beginning; the game on screen opens where it stands, so a look back and
  // straight out again leaves its battlefield untouched.
  whenIdle(() => { endReel(false); openReplay(rec, text === undefined ? rec.moves.length : 0); });
  return true;
}
/** Switch to replaying `rec` at `ply` (no waiting: call when idle). */
function openReplay(rec: { fen: string; moves: Ply[]; code: string; classic?: Classic }, ply: number) {
  const back = rp?.back ?? { fen: startFen(engine), moves: plies(engine) };
  rp = { ...rec, back, playing: false, speed: rp?.speed ?? 1, token: 0 };
  aiEpoch++; thinking = false; clock.userScale = rp.speed; rig.director = mode === 'watch';
  hud.closeShare(); hud.replay(true);
  seekNow(ply);
}
/** Jump to `ply` instantly. */
function seekNow(ply: number) {
  if (!rp) return;
  rp.token++;
  if (rp.classic) classicCard(); // a jump leaves no stale caption
  rebuild(rp.fen, rp.moves.slice(0, Math.max(0, Math.min(rp.moves.length, ply))));
  resetState();
  if (over) world.setMood(progress, 0.75, 1); // a finished position shows its ending weather at once
}
const pause = () => { if (rp) { rp.playing = false; rp.token++; } rig.director = mode === 'watch'; };
function replaySeek(ply: number) { if (!rp || reel) return; pause(); const r = rp; whenIdle(() => { if (rp === r) seekNow(ply); }); refresh(); }
/** One ply back (during a move: the position before it). */
function replayPrev() { if (rp) replaySeek(engine.history.length - 1); }
/** Animate the next recorded move. */
function replayStep() {
  if (!rp || busy) return;
  const m = rp.moves[engine.history.length];
  if (!m) { pause(); refresh(); return; }
  void play(m.from, m.to);
  if (rp.classic && !reel) captionMove();
}
function replayNext() { if (!rp || reel) return; pause(); whenIdle(replayStep); refresh(); }
function replayToggle() {
  if (!rp || reel) return;
  if (rp.playing) { pause(); refresh(); return; }
  rp.playing = true; rp.token++; rig.director = true;
  const r = rp;
  whenIdle(() => { if (rp !== r) return; if (engine.history.length >= r.moves.length) seekNow(0); replayStep(); });
  refresh();
}
function replaySpeed() { if (!rp || reel) return; rp.speed = rp.speed >= 4 ? 1 : rp.speed * 2; if (!queued) clock.userScale = rp.speed; refresh(); }
/** Called when a replayed move has finished animating: keep playing after a short beat. */
function replayed() {
  if (!rp) return;
  if (engine.history.length >= rp.moves.length) { pause(); if (rp.classic && !reel) classicEnd(); }
  refresh();
  if (!rp.playing) return;
  const r = rp, tok = rp.token;
  void wait(0.45).then(() => { if (rp === r && r.playing && r.token === tok && !busy) replayStep(); });
}
/** Back to the live game as it was (a finished game shows its result card again). */
function leaveReplay() {
  if (!rp) return;
  endReel(false);
  const b = rp.back;
  if (rp.classic) classicCard();
  rp = null; clock.userScale = baseScale; queued = null;
  hud.replay(false); hud.closeShare();
  rig.director = mode === 'watch';
  if (location.hash.startsWith('#g=')) history.replaceState(null, '', location.pathname + location.search);
  rebuild(b.fen, b.moves);
  resetState();
  if (over) showOver(refresh());
}
function replayExit() { if (reel) { reelExit(); return; } if (!rp) return; pause(); const r = rp; whenIdle(() => { if (rp === r) leaveReplay(); }); }

// ---------- classics ----------
// A classic is an ordinary replay (its link is the usual #g= record) that opens on a title card, plays
// itself, names each move in a small caption as it is played, and closes on the source's verdict.
/** Replay classic `i` from its first move. Returns false if it cannot start. */
function playClassic(i: number): boolean {
  const c = CLASSICS[i];
  if (!c) return false;
  let rec: { fen: string; moves: Ply[]; code: string; classic: Classic };
  try { const d = classicRecord(c); rec = { fen: d.fen, moves: d.moves, code: encodeRecord(d.engine), classic: c }; }
  catch (e) { console.warn('Bad classic:', e instanceof Error ? e.message : e); hud.toast('棋谱无效'); sfx.error(); return false; }
  hud.closeClassics();
  if (!rp && !queued) baseScale = clock.userScale;
  whenIdle(() => {
    endReel(false); openReplay(rec, 0);
    const r = rp!;
    card(c.title, 'd', 3, c.source);
    // Autoplay once the title has had its moment (unless the viewer has taken over meanwhile).
    void wait(2.6).then(() => { if (rp === r && !r.playing && !reel && !engine.history.length) replayToggle(); });
  });
  return true;
}
/** Show (or with no text, clear) the classic's card. Captions use the small form of the reel's title card. */
function classicCard(text = '', sub = '', side: Caption['side'] = 'd', life = 0, small = false) { hud.reelCard(text, sub, side, life, small); burn.card = life ? caption(text, side, life, sub) : null; }
function captionMove() {
  const m = engine.history.at(-1)!, n = engine.history.length;
  classicCard(traditional(m.notation), `第 ${n} 手`, m.piece.side, 2.4, true);
}
function classicEnd() {
  const r = rp!, c = r.classic!;
  void wait(1.4).then(() => { if (rp === r && !reel && engine.history.length >= r.moves.length) classicCard(c.result ?? '終', c.title, c.end?.winner ?? c.winner ?? 'd', 3.4); });
}

// ---------- highlight reel ----------
// The reel is a replay that jumps (instantly, as a scrub does) to each clip from reel.ts and animates
// it with the full duel cinematics, a title card first, then ends on the final position. It keeps the
// replay's discipline: everything waits for the running move (whenIdle), and leaving restores the
// replay or the live game it started from. Recording renders at a fixed size and copies each frame,
// overlays included, into a MediaRecorder until the end card has been shown.
interface Reel { clips: Clip[]; from: 'live' | 'replay'; ply: number; speed: number; rec: Recorder | null }
let reel: Reel | null = null, exportWait: ((r: Recording | null) => void) | null = null, stallTimer = 0;
const NUM = '一二三四五六七八九十';
/** The game a reel would be cut from: the replayed record, or the game on screen. */
const reelSource = () => (rp ? { fen: rp.fen, moves: rp.moves } : { fen: startFen(engine), moves: plies(engine) });
const settle = (r: Recording | null) => { const f = exportWait; exportWait = null; f?.(r); };
function card(text: string, side: Caption['side'], life: number, sub?: string) { hud.reelCard(text, sub ?? '', side, life); burn.card = caption(text, side, life, sub); }
/** Play the highlight reel; with `record`, also export it as a video. Returns false if it cannot start. */
function startReel(record = false): boolean {
  if (record && !canRecord()) { hud.toast('此浏览器不支持导出视频'); sfx.error(); return false; }
  if (!reel && !reelSource().moves.length) { hud.toast('尚未落子'); sfx.error(); return false; }
  if (record) sfx.unlock(); // inside the click, so the recording can carry sound
  if (!rp && !queued) baseScale = clock.userScale;
  hud.closeShare(); hud.closeVideo();
  const prev = reel;
  whenIdle(() => {
    if (reel !== prev) return;
    let from: Reel['from'] = 'replay', ply = engine.history.length, speed = rp?.speed ?? 1;
    if (prev) { ({ from, ply, speed } = prev); dropRecording(prev); }
    else if (rp) pause();
    else { from = 'live'; openReplay({ fen: startFen(engine), moves: plies(engine), code: encodeRecord(engine) }, ply); speed = rp!.speed; }
    const r: Reel = { clips: highlights(rp!.fen, rp!.moves), from, ply, speed, rec: null };
    reel = r; rp!.speed = 1; clock.userScale = 1; rig.director = true;
    hud.reel(true, record);
    if (record) beginRecording(r);
    void runReel(r);
  });
  return true;
}
async function runReel(r: Reel) {
  const live = () => reel === r && !!rp;
  const n = r.clips.length, total = rp!.moves.length;
  for (let i = 0; i < n; i++) {
    const c = r.clips[i];
    if (engine.history.length !== c.start) seekNow(c.start);
    rig.director = true;
    const span = c.end - c.start + 1, show = (k: number) => hud.reelState(i, n, c.reason, (i + k / span) / (n + 0.5));
    show(0);
    card(`其${NUM[i] ?? i + 1} · ${c.reason}`, c.side, 2.2);
    await wait(1.1); if (!live()) return;
    while (engine.history.length < c.end) {
      const m = rp!.moves[engine.history.length];
      if (!(await play(m.from, m.to)) || !live()) return;
      rig.director = true; show(engine.history.length - c.start);
      await wait(0.35); if (!live()) return;
    }
    await wait(engine.history.at(-1)?.check && !over ? 0.9 : 0.4); if (!live()) return;
  }
  // End on the final position, with the result.
  if (engine.history.length !== total) seekNow(total);
  rig.director = true;
  const st = engine.status();
  hud.reelState(n, n, '', 1);
  card(st.over ? '终局' : '集锦', st.winner ?? 'd', 3.4, st.over ? resultText(st) : `第 ${total} 手`);
  await wait(3.4); if (!live()) return;
  if (r.rec) await finishRecording(r);
  if (reel === r) endReel(true);
}
function beginRecording(r: Reel) {
  capturing = true; resize();
  try { r.rec = new Recorder(canvas, canvas.width, canvas.height, sfx.capture()); }
  catch (e) { console.warn('Cannot record:', e); hud.toast('无法导出视频'); stopCapture(); settle(null); hud.reel(true, false); return; }
  r.rec.onError = (e) => {
    console.warn('Recording failed:', e); hud.toast('视频导出失败');
    if (reel === r) { dropRecording(r); settle(null); hud.reel(true, false); }
  };
  // A hidden or throttled page stops requestAnimationFrame; keep the simulation (and the video) going.
  let prev = performance.now();
  stallTimer = window.setInterval(() => {
    const now = performance.now(), dt = (now - prev) / 1000; prev = now;
    if (!manual && now - lastRaf > 200) step(Math.min(0.05, dt));
  }, 33);
}
function stopCapture() { capturing = false; clearInterval(stallTimer); sfx.release(); resize(); }
/** Abandon a recording in progress (cancel, exit, error, or a restart). */
function dropRecording(r: Reel) { if (!r.rec) return; r.rec.cancel(); r.rec = null; stopCapture(); }
async function finishRecording(r: Reel) {
  const rec = r.rec!;
  r.rec = null; // the reel no longer owns it: leaving now does not cancel the file being written
  hud.reelState(r.clips.length, r.clips.length, '生成视频', 1);
  let res: Recording | null = null;
  try { res = await rec.finish(); } catch (e) { console.warn('Recording failed:', e); hud.toast('视频导出失败'); }
  stopCapture();
  if (res && !res.blob.size) { res = null; hud.toast('视频导出失败'); }
  if (res) hud.offerVideo(res.blob, res.mime, res.durationMs);
  settle(res);
}
/** Stop the reel. `restore` goes back to where it started (the replay at its ply, or the live game). */
function endReel(restore: boolean) {
  const r = reel;
  if (!r) return;
  reel = null;
  dropRecording(r); settle(null);
  hud.reel(false, false); hud.reelCard('', '', 'd', 0); burn.card = null;
  clock.slow = 1; clock.slowLeft = 0; clock.next = null;
  if (!rp) return;
  rp.speed = r.speed;
  if (!restore) return;
  if (r.from === 'live') { leaveReplay(); return; }
  clock.userScale = rp.speed; seekNow(r.ply); pause(); refresh();
}
/** Leave the reel (cancels an export), once the running move has finished. */
function reelExit() { const r = reel; if (r) whenIdle(() => { if (reel === r) endReel(true); }); }

/** Link and readable record of the game on screen (the whole recorded game during replay). */
function shareInfo() {
  let e = engine, code = '';
  if (rp) { e = new Engine(rp.fen); for (const m of rp.moves) e.move(m.from, m.to); code = rp.code; } else code = encodeRecord(engine);
  return { link: location.origin + location.pathname + '#g=' + code, text: toText(e) };
}
const fromHash = () => { if (location.hash.startsWith('#g=') && !enterReplay(location.hash.slice(3)) && !rp) history.replaceState(null, '', location.pathname + location.search); };
window.addEventListener('hashchange', fromHash);
// Paste a record or a link anywhere on the page to replay it.
window.addEventListener('paste', (e) => {
  const t = e.clipboardData?.getData('text') ?? '';
  if ((e.target as HTMLElement).tagName === 'INPUT' || !t.trim()) return;
  enterReplay(t);
});

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
  if (busy || over || rp || isAI(engine.turn)) return;
  const i = pickSquare(ndc);
  if (i < 0) { select(-1); return; }
  const p = engine.board[i];
  if (selected >= 0 && legal.includes(i)) void play(selected, i);
  else if (p && p.side === engine.turn) { if (i !== selected) { sfx.select(); select(i); } }
  else { if (selected >= 0 || p) sfx.error(); select(-1); }
};
rig.onHover = (ndc) => {
  if (busy || over || rp || isAI(engine.turn)) { canvas.classList.remove('pointing'); hoverRing.visible = false; return; }
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
  undo, restart: () => restart(), mode: (m) => (m === mode && m !== 'pvp' && !rp ? cycleStyle() : setMode(m)), // again: change style
  autoCam: (on) => { opts.autoCam = on; if (on && mode === 'pvp') rig.faceSide(engine.turn); },
  badges: (on) => { opts.badges = on; for (const u of units.values()) u.badge.visible = on && !u.busy; },
  sound: (on) => { sfx.unlock(); sfx.setMuted(!on); },
  music: (on) => { sfx.unlock(); music.setOn(on); },
  fine: (on) => { fineModels.on = on; if (busy) rebuildQueued = true; else { select(-1); sync(); } }, // mid-move: rebuild as soon as it ends
  replay: { enter: () => void enterReplay(), prev: replayPrev, next: replayNext, toggle: replayToggle, speed: replaySpeed, seek: replaySeek, exit: replayExit, share: shareInfo },
  reel: { start: () => void startReel(), export: () => void startReel(true), exit: reelExit },
  classics: { list: CLASSICS, play: (i) => void playClassic(i) },
});
const qBtn = document.getElementById('btn-quality')!, showQ = () => { qBtn.querySelector('span')!.textContent = '画质 ' + { high: '高', mid: '中', low: '低' }[quality.tier]; };
qBtn.onclick = () => void quality.set(quality.next());
quality.onChange.push(async (s) => {
  applyQuality(s); world.applyQuality(s); fx.applyQuality(); showQ();
  await loadModels(s.models);
  if (busy) rebuildQueued = true; else { select(-1); sync(); }
});
showQ();

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
  if (reel?.rec) { burn.time = clock.real; reel.rec.frame(burn); }
}

let last = performance.now(), lastRaf = last, manual = false; // manual: only __game.advance() steps the simulation
function frame(now: number) {
  if (!manual) step(Math.min(0.05, (now - last) / 1000));
  last = lastRaf = now;
  requestAnimationFrame(frame);
}

await loadModels(quality.s.models); // authored models must be ready before the first units are built
sync();
world.setMood(0, 0, 0, true); // open at dawn rather than easing there from the default dusk
rig.reset('r');
requestAnimationFrame(frame);
quality.probe(() => manual || !!reel);
fromHash();

// ---------- debug / test hook ----------
const yieldTask = () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
(window as any).__game = {
  engine, units, rig, clock, fx, scars, scene, renderer, grade: grade.uniforms, world, music, Score, grime,
  /** Pin the weather for testing: weather(time, storm, rain), or weather() to follow the game again. */
  weather(time?: number, storm = 0, rain = 0) { weatherLock = time !== undefined; if (weatherLock) world.setMood(time!, storm, rain, true); else refresh(); },
  get state() {
    return { turn: engine.turn as Side, busy, over, selected, mode, thinking, history: engine.history.map((m) => m.notation), status: engine.status(),
      replay: rp ? { ply: engine.history.length, total: rp.moves.length, playing: rp.playing, speed: rp.speed } : null, ai: lastAi };
  },
  /** Styles: style() both sides, style(side) one, style(side, name) sets it (from the next AI move). */
  style(side?: Side, name?: Style) {
    if (!side) return { ...styles };
    if (name) { if (!STYLES.includes(name)) throw new Error('style: ' + STYLES.join(' / ')); styles[side] = name; if (mode === 'pve' && side === 'b') pveStyle = name; styleChanged(); }
    return styles[side];
  },
  /** Opening book candidates for the position on screen, weighted for the side to move's style. */
  book() {
    if (startFen(engine) !== START_FEN) return [];
    return bookMoves(encode(engine.board), engine.turn === 'r' ? 0 : 1, styles[engine.turn]).map(({ move, weight, names }) => ({ move, weight, names }));
  },
  set timeScale(v: number) { clock.userScale = v; },
  set manual(v: boolean) { manual = v; },
  /** Switch between authored models and the original procedural ones (rebuilds every unit). */
  fine(on: boolean) { if (busy) return false; fineModels.on = on; select(-1); sync(); return true; },
  load(fen: string) { if (rp) leaveReplay(); engine.load(fen); resetState(); },
  move(s: string) { return rp ? Promise.resolve(false) : play(sq(s.slice(0, 2)), sq(s.slice(2, 4))); },
  click(s: string) { if (rp) return []; const i = sq(s), p = engine.board[i]; if (selected >= 0 && legal.includes(i)) return play(selected, i); if (p && p.side === engine.turn) select(i); return legal.map(sqName); },
  undo, restart, setMode,
  /** Compact record of the game (the replayed one during replay), as used in `#g=` links. */
  record() { return rp ? rp.code : encodeRecord(engine); },
  /** Readable record: ICCS moves with the traditional notation. */
  recordText() { return shareInfo().text; },
  /** Replay a record or link, or the current game when omitted. */
  replay(text?: string) { return enterReplay(text); },
  replayTo(ply: number) { replaySeek(ply); },
  replayStep: replayNext, replayToggle, replaySpeed,
  replayExit,
  /** Titles of the classic games, and classic(i) to replay one (title card, autoplay, captions). */
  classics() { return CLASSICS.map((c) => c.title); },
  classic(i: number) { return playClassic(i); },
  /** Highlight clips of the game on screen (the replayed one during replay), in game order. */
  highlights() { const s = reelSource(); return highlights(s.fen, s.moves); },
  /** Play the highlight reel; reelExit() leaves it (and cancels an export). */
  reel() { return startReel(); },
  reelExit,
  /** Play the reel and record it. Resolves with the file's details, or null if cancelled or failed. */
  reelExport(): Promise<{ size: number; mime: string; durationMs: number; width: number; height: number; audio: boolean; url: string } | null> {
    settle(null);
    return new Promise((res) => {
      exportWait = (r) => res(r && { size: r.blob.size, mime: r.mime, durationMs: Math.round(r.durationMs), width: r.width, height: r.height, audio: r.audio, url: hud.videoUrl });
      if (!startReel(true)) settle(null);
    });
  },
  get reelState() { return reel ? { clips: reel.clips.length, from: reel.from, recording: !!reel.rec } : null; },
  /** Quality tier: quality() returns it, quality('low' | 'mid' | 'high') switches (and saves) it. */
  quality(t?: 'low' | 'mid' | 'high') { return t ? quality.set(t).then(() => quality.tier) : quality.tier; },
  /** Drive the simulation manually (for hidden tabs where rAF is paused). */
  async advance(seconds: number, fps = 30) { for (let i = 0; i < seconds * fps; i++) { step(1 / fps); await yieldTask(); } },
};
void ease;
