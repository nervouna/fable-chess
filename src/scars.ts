// Persistent battlefield scars: instanced ground decals, wreckage that stays where it fell,
// and smouldering craters. Everything is tagged with the move number so undo can roll it back.
import * as THREE from 'three';
import { colX, disposeTree, rand, randS, rowZ, terraceInset, tween } from './core';
import { fx } from './fx';

export type ScarKind = 'scorch' | 'crater' | 'stain' | 'crack' | 'hoof' | 'rut' | 'gash' | 'foot';
const CELL: Record<ScarKind, number> = { scorch: 0, crater: 1, stain: 2, crack: 3, hoof: 4, rut: 5, gash: 6, foot: 7 };
const TINT: Record<ScarKind, number> = { scorch: 0x0b0908, crater: 0x1a1512, stain: 0x520a06, crack: 0x0c0a09, hoof: 0x0f0c09, rut: 0x0f0c09, gash: 0x090807, foot: 0x0f0c09 };
const TRACE = new Set<ScarKind>(['hoof', 'rut', 'foot']);
const MAX = 720, MAX_WRECK = 110, MAX_SMOLDER = 6, C = 256;

interface Decal { kind: ScarKind; x: number; z: number; rot: number; sx: number; sz: number; a: number; ply: number }

/** 4x2 atlas of white-on-transparent marks; the shader multiplies in a per-instance tint. */
function makeAtlas() {
  const cv = document.createElement('canvas'); cv.width = C * 4; cv.height = C * 2;
  const g = cv.getContext('2d')!;
  const cell = (i: number, fn: () => void) => {
    g.save(); g.beginPath(); g.rect((i % 4) * C, ((i / 4) | 0) * C, C, C); g.clip();
    g.translate((i % 4) * C + C / 2, ((i / 4) | 0) * C + C / 2); fn(); g.restore();
  };
  const blob = (x: number, y: number, r: number, a: number, col = '255,255,255') => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(0.6, `rgba(${col},${a * 0.6})`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  const spokes = (n: number, r0: number, r1: number, w: number, a: number) => {
    g.strokeStyle = `rgba(255,255,255,${a})`; g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const th = (i / n) * 6.283 + randS(0.2), r = rand(r0, r1);
      g.lineWidth = rand(w * 0.4, w); g.beginPath(); g.moveTo(Math.cos(th) * r0 * 0.5, Math.sin(th) * r0 * 0.5); g.lineTo(Math.cos(th) * r, Math.sin(th) * r); g.stroke();
    }
  };
  // 0 scorch: soft soot with ragged tongues
  cell(0, () => { blob(0, 0, 112, 0.95); for (let i = 0; i < 26; i++) { const th = rand(6.283), r = rand(40, 92); blob(Math.cos(th) * r, Math.sin(th) * r, rand(14, 34), 0.5); } spokes(22, 50, 120, 7, 0.35); });
  // 1 crater: dark pit, pale ejecta rim, radial streaks
  cell(1, () => {
    spokes(30, 60, 122, 5, 0.5); blob(0, 0, 96, 0.9);
    g.strokeStyle = 'rgba(190,175,150,0.8)'; g.lineWidth = 9; g.beginPath();
    for (let i = 0; i <= 40; i++) { const th = (i / 40) * 6.283, r = 58 + Math.sin(th * 5) * 5 + randS(4); g.lineTo(Math.cos(th) * r, Math.sin(th) * r); }
    g.closePath(); g.stroke(); blob(0, 0, 50, 1, '40,34,30');
  });
  // 2 stain: irregular pooled splatter
  cell(2, () => { blob(0, 0, 62, 1); for (let i = 0; i < 9; i++) { const th = rand(6.283), r = rand(20, 52); blob(Math.cos(th) * r, Math.sin(th) * r, rand(16, 34), 0.9); } for (let i = 0; i < 34; i++) { const th = rand(6.283), r = rand(60, 120); blob(Math.cos(th) * r, Math.sin(th) * r, rand(3, 9) * (1.3 - r / 120), 0.9); } });
  // 3 crack: branching fractures
  cell(3, () => {
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineCap = 'round';
    const branch = (x: number, y: number, th: number, len: number, w: number) => {
      if (len < 8 || Math.hypot(x, y) > 118) return;
      const nx = x + Math.cos(th) * len, ny = y + Math.sin(th) * len;
      g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      branch(nx, ny, th + randS(0.5), len * 0.82, w * 0.8);
      if (Math.random() < 0.45) branch(nx, ny, th + (Math.random() < 0.5 ? 1 : -1) * rand(0.5, 1.1), len * 0.6, w * 0.6);
    };
    for (let i = 0; i < 9; i++) branch(0, 0, (i / 9) * 6.283 + randS(0.25), 30, 5);
    blob(0, 0, 40, 0.6);
  });
  // 4 hoof: two staggered pairs of crescents (heading = +y in texture space)
  cell(4, () => {
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 9; g.lineCap = 'round';
    for (const [x, y] of [[-34, -62], [30, -40], [-30, 44], [36, 70]]) { g.beginPath(); g.arc(x, y, 17, Math.PI * 0.15, Math.PI * 0.85, true); g.stroke(); blob(x, y, 30, 0.25); }
  });
  // 5 rut: twin wheel tracks running the full height so tiles chain up
  cell(5, () => { for (const x of [-98, 98]) { const gr = g.createLinearGradient(x - 16, 0, x + 16, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - 16, -128, 32, 256); } });
  // 6 gash: long tapered cut
  cell(6, () => { g.fillStyle = 'rgba(255,255,255,0.95)'; g.beginPath(); g.moveTo(0, -122); g.quadraticCurveTo(13, 0, 0, 122); g.quadraticCurveTo(-13, 0, 0, -122); g.fill(); for (let i = 0; i < 16; i++) blob(randS(14), randS(110), rand(5, 13), 0.5); });
  // 7 foot: four heavy round pads
  cell(7, () => { for (const [x, y] of [[-52, -58], [52, -46], [-52, 50], [52, 62]]) { blob(x, y, 42, 0.75); g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 4; g.beginPath(); g.arc(x, y, 27, 0, 7); g.stroke(); } });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

class Scars {
  /** Current move number; everything created is tagged with it. */
  get ply() { return fx.tag; }
  set ply(v: number) { fx.tag = v; }
  private mesh!: THREE.InstancedMesh;
  private aCell!: THREE.InstancedBufferAttribute;
  private aTint!: THREE.InstancedBufferAttribute;
  private decals: Decal[] = [];
  private wreck: { o: THREE.Object3D; ply: number }[] = [];
  private smolder: { x: number; z: number; ply: number }[] = [];
  private d = new THREE.Object3D();
  private col = new THREE.Color();

  init(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.aCell = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    geo.setAttribute('aCell', this.aCell); geo.setAttribute('aTint', this.aTint);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: makeAtlas() } },
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        attribute float aCell; attribute vec4 aTint; varying vec2 vUv; varying vec4 vTint;
        void main(){
          float cx=mod(aCell,4.0), cy=floor(aCell/4.0);
          vUv=vec2((uv.x+cx)/4.0,(uv.y+1.0-cy)/2.0); vTint=aTint;
          gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; varying vec2 vUv; varying vec4 vTint;
        void main(){ vec4 t=texture2D(uMap,vUv); float a=t.a*vTint.a; if(a<0.004) discard; gl_FragColor=vec4(t.rgb*vTint.rgb,a); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    fx.onRest = (o, ply) => this.keep(o, ply);
  }

  private write(i: number, alpha?: number) {
    const k = this.decals[i], d = this.d;
    d.position.set(k.x, 0.012 + i * 0.00002, k.z); d.rotation.set(0, k.rot, 0); d.scale.set(k.sx, 1, k.sz); d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix);
    this.aCell.setX(i, CELL[k.kind]);
    this.col.set(TINT[k.kind]);
    this.aTint.setXYZW(i, this.col.r, this.col.g, this.col.b, alpha ?? k.a);
  }
  private flush() { this.mesh.count = this.decals.length; this.mesh.instanceMatrix.needsUpdate = true; this.aCell.needsUpdate = true; this.aTint.needsUpdate = true; }
  private rebuild() { for (let i = 0; i < this.decals.length; i++) this.write(i); this.flush(); }

  /** Stamp a mark on the terrace. `dir` orients it (the texture's long axis follows the heading). */
  mark(kind: ScarKind, p: { x: number; z: number }, size: number, alpha = 0.6, dir?: { x: number; z: number }, aspect = 1) {
    const inset = terraceInset(p.x, p.z);
    const fit = Math.min(size, Math.max(0, inset) * 2 + 0.3);
    if (fit < size * 0.45) return; // would hang over the river or the kerb
    // Keep the grid readable: cap how much can pile up on one spot.
    const trace = TRACE.has(kind), r = trace ? 0.5 : 1.0;
    let near = 0;
    for (const k of this.decals) if (TRACE.has(k.kind) === trace && Math.abs(k.x - p.x) < r && Math.abs(k.z - p.z) < r) near++;
    if (near >= (trace ? 2 : 3)) return;
    if (this.decals.length >= MAX) { this.decals.splice(0, 60); this.rebuild(); }
    const k: Decal = { kind, x: p.x, z: p.z, rot: dir ? Math.atan2(dir.x, dir.z) : rand(6.283), sx: fit * aspect, sz: fit, a: Math.min(alpha * (trace ? 1.35 : 1), 0.72), ply: this.ply };
    this.decals.push(k);
    this.write(this.decals.length - 1, 0); this.flush();
    tween(0.45, (t) => { const i = this.decals.indexOf(k); if (i >= 0) { this.aTint.setW(i, k.a * t); this.aTint.needsUpdate = true; } });
  }

  /** A blast site: crater over soot, left smouldering. */
  blast(p: { x: number; z: number }, scale = 1) {
    this.mark('scorch', p, 3.6 * scale, 0.62);
    this.mark('crater', p, 2.3 * scale, 0.7);
    if (terraceInset(p.x, p.z) > 0.4) { this.smolder.push({ x: p.x, z: p.z, ply: this.ply }); if (this.smolder.length > MAX_SMOLDER) this.smolder.shift(); }
  }

  /** Take ownership of a fragment that has come to rest, sliding it clear of any board point. */
  keep(o: THREE.Object3D, ply = this.ply) {
    const cx = colX(Math.max(0, Math.min(8, Math.round(o.position.x / 2 + 4)))), dz = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(rowZ).reduce((a, b) => (Math.abs(b - o.position.z) < Math.abs(a - o.position.z) ? b : a));
    let ox = o.position.x - cx, oz = o.position.z - dz;
    const d = Math.hypot(ox, oz);
    if (d < 0.86) {
      if (d < 0.05) { const a = rand(6.283); ox = Math.cos(a); oz = Math.sin(a); } else { ox /= d; oz /= d; }
      const tx = cx + ox * rand(0.88, 1.0), tz = dz + oz * rand(0.88, 1.0);
      if (terraceInset(tx, tz) > 0.2) { const x0 = o.position.x, z0 = o.position.z; tween(0.3, (t) => { o.position.x = x0 + (tx - x0) * t; o.position.z = z0 + (tz - z0) * t; }); }
    }
    this.wreck.push({ o, ply });
    while (this.wreck.length > MAX_WRECK) disposeTree(this.wreck.shift()!.o);
  }

  /** Drop everything created after move `ply` (0 clears the field). */
  rewind(ply: number) {
    this.ply = ply;
    const n = this.decals.length;
    this.decals = this.decals.filter((k) => k.ply <= ply);
    if (this.decals.length !== n) this.rebuild();
    this.wreck = this.wreck.filter((w) => w.ply <= ply || (disposeTree(w.o), false));
    this.smolder = this.smolder.filter((s) => s.ply <= ply);
  }

  update(dt: number) {
    for (const s of this.smolder) {
      if (Math.random() < dt * 2.2) fx.smoke(this.d.position.set(s.x + randS(0.3), 0.1, s.z + randS(0.3)), 1, 0.55);
      if (Math.random() < dt * 1.5) fx.embers(this.d.position.set(s.x, 0.05, s.z), 1, 0xff7020, 0.35, 1.3);
    }
  }

  get stats() { return { decals: this.decals.length, wreck: this.wreck.length, smolder: this.smolder.length }; }
}

export const scars = new Scars();
