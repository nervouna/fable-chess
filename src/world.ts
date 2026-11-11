// The battlefield: terrain, river, stone board terraces, fortresses, props, sky and lighting.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BANK, blocksSight, BRIDGE_X, clamp, colX, lerp, rand, randS, riverCenter, rowZ, smooth, tween, WATER_Y } from './core';
import { fx } from './fx';
import { box, clothMat, cone, cyl, FONT, glyphTexture, group, mesh, sph, std, TEAM, timeU } from './kit';
import { quality, type Settings } from './quality';
import { river } from './river';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.4, -0.73).normalize();
const FOG = new THREE.Color().setRGB(0.3, 0.215, 0.3);

// ---------- noise ----------
const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx_ = smooth(x - ix), fy = smooth(y - iy);
  return lerp(lerp(hash(ix, iy), hash(ix + 1, iy), fx_), lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx_), fy);
}
function fbm(x: number, y: number, oct = 5) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); n += a; a *= 0.5; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; }
  return s / n;
}
const sstep = (a: number, b: number, v: number) => smooth(clamp((v - a) / (b - a), 0, 1));

const riverWidth = (x: number) => 1.25 + sstep(10, 30, Math.abs(x)) * 2.6;

/** The valley as an N x N grid, denser towards the board, with vertex colours. */
function terrainGeo(N: number) {
  const R = 150, pos = new Float32Array((N + 1) * (N + 1) * 3), index: number[] = [];
  const warp = (u: number) => Math.sign(u) * Math.pow(Math.abs(u), 1.7) * R;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = warp((i / N) * 2 - 1), z = warp((j / N) * 2 - 1), k = (j * (N + 1) + i) * 3;
    pos[k] = x; pos[k + 1] = terrainH(x, z); pos[k + 2] = z;
    if (i < N && j < N) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; index.push(a, c, b, b, c, d); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index); g.computeVertexNormals();
  const nrm = g.attributes.normal, col = new Float32Array(pos.length), c = new THREE.Color();
  const mud = new THREE.Color(0x4b3e2c), dirt = new THREE.Color(0x77633f), grass = new THREE.Color(0x56602f), rock = new THREE.Color(0x5b5650), snow = new THREE.Color(0xc9c6d4);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3], h = pos[i * 3 + 1], z = pos[i * 3 + 2], slope = 1 - nrm.getY(i);
    c.copy(dirt).lerp(grass, sstep(0.35, 0.65, fbm(x * 0.12 + 3, z * 0.12)));
    c.lerp(mud, 1 - sstep(-0.6, -0.15, h));
    c.lerp(rock, clamp(sstep(0.12, 0.4, slope) + sstep(9, 22, h), 0, 1));
    c.lerp(snow, sstep(24, 34, h + fbm(x * 0.1, z * 0.1) * 6) * (1 - sstep(0.3, 0.6, slope)));
    c.multiplyScalar(0.8 + fbm(x * 0.7, z * 0.7, 3) * 0.4);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function terrainH(x: number, z: number) {
  const dx = Math.max(0, Math.abs(x) - 14), dz = Math.max(0, Math.abs(z) - 28), dist = Math.hypot(dx, dz);
  const rd = Math.abs(z - riverCenter(x)), rw = riverWidth(x);
  let h = -0.1 + (fbm(x * 0.07, z * 0.07) - 0.42) * 3.2 * sstep(0, 12, dist);
  const far = sstep(14, 90, dist);
  const ridge = 1 - Math.abs(fbm(x * 0.016 + 7, z * 0.016 + 3, 4) * 2 - 1);
  h += far * far * (ridge * 46 + fbm(x * 0.05, z * 0.05) * 9) * sstep(2, 30, rd);
  return lerp(h, Math.min(h, -1.0), 1 - sstep(rw * 0.6, rw * 1.6, rd));
}

// ---------- shaders ----------
const NOISE_GLSL = /* glsl */ `
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); a*=0.5; p=p*2.03+vec2(17.1,9.7);} return s; }`;

// Sky palette shared (by reference) between the sky dome and the water (river.ts); the weather
// system rewrites these values every frame.
const V3 = (r: number, g: number, b: number) => ({ value: new THREE.Vector3(r, g, b) });
const SKY = {
  uZen: V3(0.018, 0.035, 0.11), uMid: V3(0.2, 0.13, 0.28), uHor: V3(0.34, 0.2, 0.3), uHorSun: V3(1.25, 0.52, 0.2),
  uCloudA: V3(0.16, 0.12, 0.2), uCloudB: V3(1.3, 0.62, 0.3), uSunCol: V3(1.0, 0.72, 0.4),
  uStars: { value: 1 }, uCover: { value: 0 }, uFlash: { value: 0 },
};
const SKY_GLSL = /* glsl */ `
uniform vec3 uZen, uMid, uHor, uHorSun;
vec3 skyBase(vec3 d, vec3 sun){
  float h=max(d.y,0.0); float sd=max(dot(normalize(vec3(d.x,0.0,d.z)), normalize(vec3(sun.x,0.0,sun.z))),0.0);
  vec3 hor=mix(uHor, uHorSun, pow(sd,2.5));
  vec3 col=mix(hor, uMid, smoothstep(0.0,0.3,h));
  return mix(col, uZen, smoothstep(0.12,0.85,h));
}`;

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: SUN_DIR }, uTime: timeU, uFog: { value: FOG }, ...SKY },
    vertexShader: `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uTime; uniform vec3 uFog; varying vec3 vDir;
      uniform vec3 uCloudA, uCloudB, uSunCol; uniform float uStars, uCover, uFlash;
      ${NOISE_GLSL} ${SKY_GLSL}
      void main(){
        vec3 d=normalize(vDir); float sd=max(dot(d,uSun),0.0);
        vec3 col=skyBase(d,uSun);
        col+=(uSunCol*pow(sd,900.0)*9.0 + uSunCol*vec3(1.0,0.62,0.4)*pow(sd,10.0)*0.55)*(1.0-uCover);
        vec2 cp=d.xz/(abs(d.y)+0.14)*1.3+vec2(uTime*(0.006+uCover*0.02),0.0);
        float c=smoothstep(0.42-uCover*0.34,0.8-uCover*0.3,fbm(cp))*smoothstep(0.02,0.22,d.y);
        vec3 cc=mix(uCloudA, uCloudB, pow(sd,3.0)*0.85+0.08);
        col=mix(col,cc,c*(0.75+0.25*uCover));
        col+=uFlash*vec3(0.55,0.65,0.9)*(0.2+c*fbm(cp*2.0+3.0));
        vec2 sp=d.xz/(d.y+0.3)*190.0; float st=step(0.997,hash(floor(sp)))*smoothstep(0.3,0.8,d.y);
        col+=st*(0.5+0.5*sin(uTime*2.0+hash(floor(sp))*40.0))*0.9*uStars*(1.0-c);
        col=mix(col,uFog,smoothstep(0.03,-0.06,d.y));
        gl_FragColor=vec4(col,1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(480, 48, 24), mat);
  m.frustumCulled = false;
  return m;
}

// ---------- board terrace textures ----------
const TX0 = -9.4, TX1 = 9.4, PPU = 104;
function boardTextures(side: 'r' | 'b') {
  const z0 = side === 'r' ? BANK : -11, z1 = side === 'r' ? 11 : -BANK;
  const W = Math.round((TX1 - TX0) * PPU), H = Math.round((z1 - z0) * PPU);
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const cv = mk(), ev = mk();
  const g = cv.getContext('2d')!, eg = ev.getContext('2d')!;
  const X = (x: number) => (x - TX0) * PPU, Z = (z: number) => (z - z0) * PPU;
  const rows = side === 'r' ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
  const zin = rowZ(side === 'r' ? 5 : 4), zout = rowZ(side === 'r' ? 9 : 0);

  // Stone paving
  g.fillStyle = '#857b69'; g.fillRect(0, 0, W, H);
  const tile = PPU * 1.0;
  for (let ty = 0; ty * tile < H; ty++) for (let tx = -1; tx * tile < W; tx++) {
    const ox = (ty % 2) * tile * 0.5, v = hash(tx + (side === 'r' ? 31 : 0), ty) * 26 - 13;
    g.fillStyle = `rgb(${133 + v},${123 + v},${105 + v * 0.8})`;
    g.fillRect(tx * tile + ox + 1.5, ty * tile + 1.5, tile - 3, tile - 3);
  }
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,240,210'},${rand(0.02, 0.07)})`; g.fillRect(rand(W), rand(H), rand(1, 4), rand(1, 4)); }
  // Palace carpet
  const pz0 = Math.min(rowZ(side === 'r' ? 7 : 0), rowZ(side === 'r' ? 9 : 2)), pz1 = Math.max(rowZ(side === 'r' ? 7 : 0), rowZ(side === 'r' ? 9 : 2));
  g.fillStyle = side === 'r' ? 'rgba(150,26,16,0.42)' : 'rgba(14,34,58,0.5)';
  g.fillRect(X(colX(3)) - 30, Z(pz0) - 30, X(colX(5)) - X(colX(3)) + 60, Z(pz1) - Z(pz0) + 60);
  eg.fillStyle = '#000'; eg.fillRect(0, 0, W, H);

  const line = (x1: number, zA: number, x2: number, zB: number, w = 1) => {
    for (const [ctx, style, lw, blur] of [[g, '#231a10', 9 * w, 0], [g, '#e6b655', 3.2 * w, 0], [eg, '#ffc864', 3 * w, 10]] as const) {
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.shadowColor = '#ffb040'; ctx.shadowBlur = blur;
      ctx.beginPath(); ctx.moveTo(X(x1), Z(zA)); ctx.lineTo(X(x2), Z(zB)); ctx.stroke();
    }
  };
  for (const r of rows) line(colX(0), rowZ(r), colX(8), rowZ(r));
  for (let c = 0; c < 9; c++) line(colX(c), zin, colX(c), zout);
  // Outer frame
  const m = 0.42, zo = zout + Math.sign(zout) * m, zi = zin;
  line(colX(0) - m, zo, colX(8) + m, zo, 1.5); line(colX(0) - m, zo, colX(0) - m, zi, 1.5); line(colX(8) + m, zo, colX(8) + m, zi, 1.5);
  // Palace diagonals
  line(colX(3), pz0, colX(5), pz1); line(colX(5), pz0, colX(3), pz1);
  // Cannon / pawn position marks
  const mark = (c: number, r: number) => {
    const x = colX(c), z = rowZ(r), o = 0.14, l = 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if ((c === 0 && sx < 0) || (c === 8 && sx > 0)) continue;
      line(x + sx * o, z + sz * o, x + sx * (o + l), z + sz * o, 0.7); line(x + sx * o, z + sz * o, x + sx * o, z + sz * (o + l), 0.7);
    }
  };
  if (side === 'r') { mark(1, 7); mark(7, 7); for (let c = 0; c < 9; c += 2) mark(c, 6); }
  else { mark(1, 2); mark(7, 2); for (let c = 0; c < 9; c += 2) mark(c, 3); }

  const map = new THREE.CanvasTexture(cv), emap = new THREE.CanvasTexture(ev);
  map.colorSpace = THREE.SRGBColorSpace; emap.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = emap.anisotropy = 16;
  return { map, emap, z0, z1 };
}

function riverText(text: string) {
  const c = document.createElement('canvas'); c.width = 768; c.height = 256;
  const g = c.getContext('2d')!;
  g.font = `bold 190px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = '#ffd27a'; g.shadowBlur = 24; g.fillStyle = '#ffe2a0';
  [...text].forEach((ch, i) => g.fillText(ch, 192 + i * 384, 138));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- weather keyframes ----------
// Colours are linear RGB. The dusk key reproduces the original fixed look.
interface Key {
  light: number[]; sun: number[]; sunCol: number[]; sunInt: number; hemiSky: number[]; hemiGnd: number[]; hemiInt: number; rimInt: number;
  fog: number[]; fogDen: number; zen: number[]; mid: number[]; hor: number[]; horSun: number[]; cloudA: number[]; cloudB: number[];
  stars: number; env: number; exposure: number; rays: number; mist: number;
}
const DAWN: Key = {
  light: [1.0, 0.78, 0.6], sun: [0.7, 0.27, 0.5], sunCol: [1.0, 0.8, 0.66], sunInt: 2.7, hemiSky: [0.46, 0.56, 0.8], hemiGnd: [0.09, 0.09, 0.11], hemiInt: 1.2, rimInt: 0.6,
  fog: [0.4, 0.45, 0.57], fogDen: 0.0072, zen: [0.16, 0.26, 0.48], mid: [0.42, 0.5, 0.68], hor: [0.66, 0.66, 0.72], horSun: [1.3, 0.88, 0.62],
  cloudA: [0.42, 0.45, 0.55], cloudB: [1.2, 0.95, 0.85], stars: 0.15, env: 0.7, exposure: 1.12, rays: 0, mist: 3,
};
const NOON: Key = {
  light: [1.0, 0.93, 0.82], sun: [-0.18, 0.9, -0.34], sunCol: [1.0, 0.95, 0.86], sunInt: 2.9, hemiSky: [0.5, 0.66, 1.0], hemiGnd: [0.15, 0.12, 0.08], hemiInt: 0.92, rimInt: 0.5,
  fog: [0.52, 0.64, 0.82], fogDen: 0.0042, zen: [0.09, 0.24, 0.6], mid: [0.3, 0.48, 0.8], hor: [0.62, 0.74, 0.9], horSun: [0.9, 0.9, 0.95],
  cloudA: [0.6, 0.64, 0.72], cloudB: [1.15, 1.12, 1.08], stars: 0, env: 0.8, exposure: 0.84, rays: 0, mist: 0.6,
};
const DUSK: Key = {
  light: [1.0, 0.552, 0.254], sun: [-0.55, 0.4, -0.73], sunCol: [1.0, 0.72, 0.4], sunInt: 3.4, hemiSky: [0.34, 0.43, 0.82], hemiGnd: [0.1, 0.056, 0.03], hemiInt: 1.05, rimInt: 0.85,
  fog: [0.3, 0.215, 0.3], fogDen: 0.0085, zen: [0.018, 0.035, 0.11], mid: [0.2, 0.13, 0.28], hor: [0.34, 0.2, 0.3], horSun: [1.25, 0.52, 0.2],
  cloudA: [0.16, 0.12, 0.2], cloudB: [1.3, 0.62, 0.3], stars: 1, env: 0.75, exposure: 1.2, rays: 1, mist: 1,
};
const tmpV = new THREE.Vector3(), ORIGIN = new THREE.Vector3();

// ---------- world ----------
interface Brazier { pos: THREE.Vector3; light: THREE.PointLight | null; seed: number }

export class World {
  scene: THREE.Scene;
  sun!: THREE.DirectionalLight;
  private water!: THREE.Mesh;
  private braziers: Brazier[] = [];
  /** Flank flags, which dip into the ground when they stand between the camera and its subject. */
  private flags: { g: THREE.Group; dip: number }[] = [];
  private rays: THREE.Mesh[] = [];
  private acc = 0;
  private hemi!: THREE.HemisphereLight;
  private rim!: THREE.DirectionalLight;
  private bolt!: THREE.DirectionalLight;
  private tops: THREE.MeshStandardMaterial[] = [];
  private renderer!: THREE.WebGLRenderer;
  private envScene = new THREE.Scene();
  private baked = { time: 1, storm: 0 };
  private pmrem?: THREE.PMREMGenerator;
  private envRT?: THREE.WebGLRenderTarget;
  private rain!: THREE.LineSegments;
  private wet = 0;
  private nextStrike = 3;
  /** Smoothed weather state: time of day (0 dawn, 0.5 noon, 1 dusk), storm and rain in 0..1. */
  mood = { time: 1, storm: 0, rain: 0 };
  private goal = { time: 1, storm: 0, rain: 0 };
  /** Tone-mapping exposure that suits the current light. */
  exposure = 1.2;
  /** Set while a capture cinematic runs: no random lightning on top of impact frames. */
  quiet = false;
  onThunder: (delay: number) => void = () => {};

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    scene.fog = new THREE.FogExp2(FOG, 0.0085);
    (scene.fog as THREE.FogExp2).color = FOG; // share one Color with the sky's horizon haze
    scene.background = FOG;
    this.sky(renderer);
    this.lights();
    this.terrain();
    const n = scene.children.length;
    this.board();
    this.bridges();
    this.fortress('r'); this.fortress('b');
    this.props();
    this.scenery = scene.children.slice(n);
    this.lightShafts();
    this.applyQuality(quality.s);
  }

  // ---------- quality ----------
  private ground!: THREE.Mesh;
  private trees!: THREE.InstancedMesh;
  private rocks!: THREE.InstancedMesh;
  /** Roots built by board/bridges/fortress/props: static except for cloth. */
  private scenery: THREE.Object3D[] = [];
  private merged: THREE.Mesh[] = [];
  private mergedKey = '';

  /** Shadow resolution, terrain density, prop shadows and merged scenery for a quality tier. */
  applyQuality(s: Settings) {
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== s.shadowSize) { sh.mapSize.set(s.shadowSize, s.shadowSize); sh.map?.dispose(); sh.map = null; }
    if (this.ground.userData.n !== s.terrain) { this.ground.geometry.dispose(); this.ground.geometry = terrainGeo(s.terrain); this.ground.userData.n = s.terrain; }
    this.trees.castShadow = this.rocks.castShadow = s.propShadows;
    river.applyQuality(s);
    const key = s.merge ? `merge-${s.propShadows}` : '';
    if (key !== this.mergedKey) { this.mergedKey = key; this.mergeScenery(s); }
  }

  /**
   * Draw the static scenery as one mesh per material (and shadow flags) instead of ~450 small ones.
   * The originals stay in the scene, hidden, so the top tier can show them again unchanged.
   */
  private mergeScenery(s: Settings) {
    for (const m of this.merged) { m.removeFromParent(); m.geometry.dispose(); }
    this.merged = [];
    const parts: THREE.Mesh[] = [];
    const ok = (o: THREE.Object3D): boolean => {
      const m = o as THREE.Mesh, mat = m.material as THREE.Material;
      const fit = m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(mat) && !mat.transparent
        && mat.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && !!m.geometry.index; // cloth animates in its shader
      return fit && o.children.every(ok);
    };
    const walk = (o: THREE.Object3D) => { if (ok(o)) o.traverse((c) => parts.push(c as THREE.Mesh)); else o.children.forEach(walk); };
    this.scenery.forEach(walk);
    for (const p of parts) p.visible = !s.merge;
    if (!s.merge) return;
    // Materials that only differ by instance (the camp tents) share one draw.
    const twin = new Map<string, THREE.Material>();
    const same = (mat: THREE.Material) => {
      const m = mat as THREE.MeshStandardMaterial;
      const k = m.map || !m.isMeshStandardMaterial ? mat.uuid : [m.color.getHex(), m.emissive.getHex(), m.roughness, m.metalness, m.flatShading].join();
      if (!twin.has(k)) twin.set(k, mat);
      return twin.get(k)!;
    };
    const buckets = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; order: number; geos: THREE.BufferGeometry[] }>();
    this.scene.updateMatrixWorld(true);
    for (const p of parts) {
      const mat = same(p.material as THREE.Material), cast = p.castShadow && (s.propShadows || !p.userData.prop);
      const k = [mat.uuid, cast, p.receiveShadow, p.renderOrder].join();
      if (!buckets.has(k)) buckets.set(k, { mat, cast, recv: p.receiveShadow, order: p.renderOrder, geos: [] });
      const g = new THREE.BufferGeometry(); // copies: the originals stay intact for the top tier
      for (const a of ['position', 'normal', 'uv']) g.setAttribute(a, p.geometry.getAttribute(a).clone());
      g.setIndex(p.geometry.index);
      buckets.get(k)!.geos.push(g.applyMatrix4(p.matrixWorld));
    }
    for (const b of buckets.values()) {
      const m = new THREE.Mesh(mergeGeometries(b.geos)!, b.mat);
      for (const g of b.geos) g.dispose();
      m.castShadow = b.cast; m.receiveShadow = b.recv; m.renderOrder = b.order;
      this.scene.add(m); this.merged.push(m);
    }
  }

  private sky(renderer: THREE.WebGLRenderer) {
    const sky = makeSky();
    // Bake the sky into an environment map so metals get believable reflections.
    this.renderer = renderer;
    this.envScene.add(new THREE.Mesh(sky.geometry, sky.material));
    this.bakeEnv();
    this.scene.environmentIntensity = 0.75;
    this.scene.add(sky);
  }

  /** Re-render the sky into the environment map so reflections follow the weather. */
  private bakeEnv() {
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 1000);
    this.scene.environment = this.envRT.texture;
    old?.dispose(); // the render target owns the GPU memory, not just its texture
    this.baked.time = this.mood.time; this.baked.storm = this.mood.storm > 0.5 ? 1 : 0;
  }

  private lights() {
    const s = this.scene;
    s.add((this.hemi = new THREE.HemisphereLight(0x9db0ea, 0x5a4330, 1.05)));
    this.bolt = new THREE.DirectionalLight(0xc4d4ff, 0); this.bolt.position.set(20, 60, -30);
    s.add(this.bolt);
    const sun = (this.sun = new THREE.DirectionalLight(0xffc48a, 3.4));
    sun.position.copy(SUN_DIR).multiplyScalar(70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const c = sun.shadow.camera; c.left = -19; c.right = 19; c.top = 19; c.bottom = -19; c.near = 20; c.far = 130;
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.035;
    s.add(sun, sun.target);
    const rim = (this.rim = new THREE.DirectionalLight(0x6f8cff, 0.85));
    rim.position.set(30, 35, 50);
    s.add(rim);
    this.makeRain();
  }

  private terrain() {
    const m = (this.ground = new THREE.Mesh(terrainGeo(quality.s.terrain), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
    m.userData.n = quality.s.terrain;
    m.receiveShadow = true;
    this.scene.add(m);
    const c = new THREE.Color();
    this.water = river.build(SKY, terrainH);
    this.scene.add(this.water);

    // Trees and rocks
    const tg = cone(1, 3.2, 6).translate(0, 1.6, 0);
    const trees = new THREE.InstancedMesh(tg, std(0xffffff, { roughness: 1 }), 420);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), std(0x6a655e, { roughness: 1 }), 110);
    const d = new THREE.Object3D();
    let n = 0, guard = 0;
    while (n < 420 && guard++ < 20000) {
      const x = randS(120), z = randS(120), h = terrainH(x, z);
      if ((Math.abs(x) < 20 && Math.abs(z) < 40) || h < 0.2 || h > 16 || fbm(x * 0.05 + 40, z * 0.05) < 0.48) continue;
      d.position.set(x, h - 0.1, z); d.rotation.set(0, rand(6.28), 0); d.scale.setScalar(rand(0.7, 1.7)); d.scale.y *= rand(0.9, 1.5); d.updateMatrix();
      trees.setMatrixAt(n, d.matrix); trees.setColorAt(n, c.setHSL(rand(0.22, 0.33), rand(0.25, 0.45), rand(0.1, 0.19))); n++;
    }
    trees.count = n; trees.castShadow = true;
    n = 0; guard = 0;
    while (n < 110 && guard++ < 5000) {
      const x = randS(60), z = randS(60), h = terrainH(x, z);
      if ((Math.abs(x) < 15.5 && Math.abs(z) < 24) || h < -0.15) continue;
      d.position.set(x, h, z); d.rotation.set(rand(6), rand(6), rand(6)); d.scale.set(rand(0.3, 1.3), rand(0.25, 0.9), rand(0.3, 1.3)); d.updateMatrix();
      rocks.setMatrixAt(n++, d.matrix);
    }
    rocks.count = n; rocks.castShadow = rocks.receiveShadow = true;
    this.scene.add(trees, rocks);
    this.trees = trees; this.rocks = rocks;
  }

  private board() {
    const stone = std(0x6f6759, { roughness: 0.95 });
    for (const side of ['r', 'b'] as const) {
      const { map, emap, z0, z1 } = boardTextures(side);
      const w = TX1 - TX0, d = z1 - z0, zc = (z0 + z1) / 2;
      mesh(box(w, 0.8, d), stone, 0, -0.401, zc, this.scene).castShadow = false;
      const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ map, emissiveMap: emap, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.78, metalness: 0.05 }));
      top.position.set(0, 0, zc); top.receiveShadow = true; this.tops.push(top.material);
      this.scene.add(top);
      // Raised kerb around the terrace
      const kerb = std(TEAM[side].dark, { roughness: 0.6 });
      const trim = std(TEAM[side].trim, { metalness: 0.6, roughness: 0.62 });
      const zo = side === 'r' ? z1 : z0;
      mesh(box(w + 0.5, 0.34, 0.3), kerb, 0, -0.02, zo + Math.sign(zo) * 0.13, this.scene);
      mesh(box(w + 0.54, 0.05, 0.34), trim, 0, 0.16, zo + Math.sign(zo) * 0.13, this.scene);
      for (const sx of [-1, 1]) {
        mesh(box(0.3, 0.34, d), kerb, sx * (w / 2 + 0.13), -0.02, zc, this.scene);
        mesh(box(0.34, 0.05, d), trim, sx * (w / 2 + 0.13), 0.16, zc, this.scene);
      }
    }
    // 楚河 / 漢界 floating on the water
    for (const [txt, x] of [['楚河', -3], ['漢界', 3]] as const) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 1.43).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: riverText(txt), transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
      p.position.set(x, WATER_Y + 0.02, 0); p.renderOrder = 2;
      this.scene.add(p);
    }
  }

  private bridges() {
    const stone = std(0x9b9484, { roughness: 0.9 }), dark = std(0x5d574d, { roughness: 1 });
    const arch = (z: number) => 0.3 * Math.cos(clamp(Math.abs(z) / BANK, 0, 1) * Math.PI * 0.5);
    for (const bx of BRIDGE_X) {
      const N = 12, L = 2.5;
      for (let i = 0; i < N; i++) {
        const za = -L / 2 + (L * i) / N, zb = za + L / N, zm = (za + zb) / 2;
        const ang = Math.atan2(arch(zb) - arch(za), zb - za);
        const seg = mesh(box(1.62, 0.16, L / N + 0.03), stone, bx, arch(zm) - 0.085, zm, this.scene);
        seg.rotation.x = -ang;
        for (const sx of [-1, 1]) {
          const rail = mesh(box(0.07, 0.07, L / N + 0.03), stone, bx + sx * 0.84, arch(zm) + 0.3, zm, this.scene);
          rail.rotation.x = -ang;
          if (i % 3 === 0 || i === N - 1) mesh(box(0.1, 0.42, 0.1), dark, bx + sx * 0.84, arch(zm) + 0.14, zm, this.scene);
        }
      }
      for (const sz of [-1, 1]) {
        mesh(box(1.5, 0.9, 0.22), dark, bx, -0.52, sz * 0.5, this.scene);
        for (const sx of [-1, 1]) { // lantern posts at the bridge heads
          mesh(box(0.14, 0.6, 0.14), dark, bx + sx * 0.84, 0.3, sz * 1.22, this.scene);
          mesh(sph(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc070 }), bx + sx * 0.84, 0.68, sz * 1.22, this.scene).castShadow = false;
        }
      }
    }
  }

  private roof(w: number, d: number, h: number, mat: THREE.Material, trim: THREE.Material, parent: THREE.Object3D, y: number) {
    const r = mesh(cone(0.7072, h, 4), mat, 0, y + h / 2, 0, parent);
    r.rotation.y = Math.PI / 4; r.scale.set(w, 1, d);
    mesh(box(w + 0.1, 0.1, d + 0.1), trim, 0, y, 0, parent);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(sph(0.12, 6, 5), trim, (sx * w) / 2, y + 0.12, (sz * d) / 2, parent);
  }

  private fortress(side: 'r' | 'b') {
    const s = side === 'r' ? 1 : -1, T = TEAM[side];
    const g = group(0, -0.1, s * 22.5, this.scene);
    if (side === 'r') g.rotation.y = Math.PI; // gate faces the board
    const wall = std(side === 'r' ? 0x8d8375 : 0x4b5059, { roughness: 0.95 });
    const band = std(T.main, { roughness: 0.6 }), trim = std(T.trim, { metalness: 0.9, roughness: 0.35 });
    const tiles = std(side === 'r' ? 0x2c3836 : 0x18262d, { roughness: 0.55, metalness: 0.2 });
    mesh(box(28, 2.4, 1.3), wall, 0, 1.2, 0, g);
    mesh(box(28.05, 0.3, 1.36), band, 0, 1.75, 0, g);
    for (let x = -13.6; x <= 13.61; x += 1.36) for (const z of [-0.5, 0.5]) mesh(box(0.8, 0.42, 0.3), wall, x, 2.6, z, g);
    // Gate tower
    mesh(box(6.4, 3.3, 2.2), wall, 0, 1.65, 0, g);
    mesh(box(2.2, 2.3, 0.2), std(0x120d0a), 0, 1.15, 1.02, g);
    mesh(box(2.5, 0.16, 0.3), trim, 0, 2.38, 1.05, g);
    const plaque = mesh(new THREE.PlaneGeometry(1.5, 0.7), new THREE.MeshStandardMaterial({ map: glyphTexture(side === 'r' ? '漢' : '楚', { w: 256, h: 128, bg: side === 'r' ? '#5e0f0c' : '#0e1218', fg: '#f2c868', size: 100, border: '#e2b04a' }), emissive: 0x332208 }), 0, 2.86, 1.12, g);
    plaque.castShadow = false;
    mesh(box(5.6, 1.25, 1.7), band, 0, 3.92, 0, g);
    for (const x of [-2.7, -0.9, 0.9, 2.7]) mesh(cyl(0.11, 0.11, 1.25), trim, x, 3.92, 0.9, g);
    this.roof(7.6, 3.4, 0.7, tiles, trim, g, 3.3);
    this.roof(6.8, 2.9, 1.25, tiles, trim, g, 4.55);
    for (const sx of [-1, 1]) {
      const t = group(sx * 13.2, 0, 0, g);
      mesh(box(2.6, 3.5, 2.6), wall, 0, 1.75, 0, t);
      mesh(box(2.3, 0.9, 2.3), band, 0, 3.9, 0, t);
      this.roof(3.5, 3.5, 1.2, tiles, trim, t, 4.35);
      // Tower banners
      mesh(cyl(0.05, 0.05, 3.4, 6), trim, 0, 6.8, 0, t);
      const flag = mesh(new THREE.PlaneGeometry(2.2, 1.3, 12, 4).translate(1.1, 0, 0), clothMat(0xffffff, glyphTexture(side === 'r' ? '漢' : '楚', { w: 256, h: 150, bg: side === 'r' ? '#b3221c' : '#1b2636', fg: '#f6d27a', size: 118, border: '#e2b04a' }), 'flag'), 0, 7.8, 0, t);
      flag.rotation.y = side === 'r' ? Math.PI : 0;
    }
    // Camp tents behind the wall
    for (let i = 0; i < 9; i++) {
      const x = randS(20), z = -rand(4.5, 15), wx = x * (side === 'r' ? -1 : 1), wz = s * 22.5 + (side === 'r' ? -z : z);
      const y = terrainH(wx, wz) + 0.1;
      const r = rand(1.3, 2);
      mesh(cone(r, r * 1.25, 8), std(i % 3 ? 0xb8a98a : T.main, { roughness: 1 }), x, y + r * 0.62, z, g).userData.prop = true;
      mesh(cyl(0.03, 0.03, 0.9, 5), trim, x, y + r * 1.25 + 0.4, z, g).userData.prop = true;
    }
  }

  private props() {
    const iron = std(0x2a2826, { metalness: 0.8, roughness: 0.5 }), wood = std(0x5a3d24, { roughness: 0.9 });
    const coal = new THREE.MeshBasicMaterial({ color: 0xff7a20 });
    let k = 0;
    for (const sx of [-1, 1]) for (const z of [-10.3, -2.3, 2.3, 10.3]) {
      const x = sx * 10.6, y = -0.1;
      const g = group(x, y, z, this.scene);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = mesh(cyl(0.035, 0.035, 1.25, 5), iron, Math.cos(a) * 0.22, 0.58, Math.sin(a) * 0.22, g);
        leg.rotation.set(Math.sin(a) * 0.32, 0, -Math.cos(a) * 0.32);
      }
      mesh(cyl(0.42, 0.2, 0.3, 10), iron, 0, 1.22, 0, g);
      mesh(cyl(0.36, 0.36, 0.04, 10), coal, 0, 1.36, 0, g).castShadow = false;
      let light: THREE.PointLight | null = null;
      if (Math.abs(z) < 5) { light = new THREE.PointLight(0xff8a3a, 30, 17, 1.7); light.position.set(x, y + 2.0, z); this.scene.add(light); }
      this.braziers.push({ pos: new THREE.Vector3(x, y + 1.42, z), light, seed: k++ * 1.7 });
    }
    // Banner poles along the flanks
    for (const sx of [-1, 1]) for (const z of [-8, -5.4, 5.4, 8]) {
      const side = z > 0 ? 'r' : 'b', T = TEAM[side];
      const g = group(sx * 11.4, -0.1, z, this.scene);
      mesh(cyl(0.045, 0.06, 4.2, 6), wood, 0, 2.1, 0, g);
      mesh(sph(0.1, 6, 5), std(T.trim, { metalness: 0.9, roughness: 0.3 }), 0, 4.25, 0, g);
      const f = mesh(new THREE.PlaneGeometry(1.5, 0.95, 10, 4).translate(0.75, 0, 0), clothMat(T.main, null, 'flag'), 0, 3.6, 0, g);
      f.rotation.y = Math.PI * 0.5 * -sx + (z > 0 ? 0.3 : -0.3);
      mesh(new THREE.PlaneGeometry(1.5, 0.12, 10, 1).translate(0.75, 0.42, 0.005), clothMat(T.trim, null, 'flag'), 0, 0, 0, f).castShadow = false;
      this.flags.push({ g, dip: 0 });
    }
    // War drums
    for (const sx of [-1, 1]) for (const z of [-6.7, 6.7]) {
      const T = TEAM[z > 0 ? 'r' : 'b'];
      const g = group(sx * 12.6, -0.1, z, this.scene);
      g.rotation.y = sx * -0.5;
      const d = mesh(cyl(0.75, 0.75, 0.8, 16), std(T.main, { roughness: 0.5 }), 0, 1.25, 0, g);
      d.rotation.z = Math.PI / 2; d.rotation.y = 0.0; d.rotation.x = 0.35;
      for (const e of [-1, 1]) {
        const skin = mesh(cyl(0.7, 0.7, 0.03, 16), std(0xe6d6b0, { roughness: 0.7 }), 0, e * 0.4, 0, d);
        skin.castShadow = false;
        mesh(new THREE.TorusGeometry(0.74, 0.04, 6, 20), std(T.trim, { metalness: 0.9, roughness: 0.35 }), 0, e * 0.36, 0, d).rotation.x = Math.PI / 2;
      }
      for (const lx of [-0.5, 0.5]) for (const lz of [-0.45, 0.45]) mesh(box(0.1, 1.0, 0.1), wood, lx, 0.5, lz, g);
      mesh(box(1.2, 0.1, 1.0), wood, 0, 0.55, 0, g);
    }
  }

  private lightShafts() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256;
    const g = c.getContext('2d')!;
    const img = g.createImageData(64, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) {
      const a = Math.pow(Math.sin((x / 63) * Math.PI), 2) * Math.pow(Math.sin((y / 255) * Math.PI), 0.7);
      img.data.set([255, 255, 255, a * 255], (y * 64 + x) * 4);
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    for (let i = 0; i < 7; i++) {
      const L = 80;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rand(2.5, 6), L),
        new THREE.MeshBasicMaterial({ map: tex, color: 0xffb070, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), SUN_DIR);
      m.position.set(-16 + i * 5 + randS(1.5), 0, randS(9)).addScaledVector(SUN_DIR, L * 0.42);
      m.rotateY(rand(-0.5, 0.5));
      m.renderOrder = 8; m.userData.ph = rand(6.28);
      this.scene.add(m); this.rays.push(m);
    }
  }

  // ---------- weather ----------
  /** Aim the weather at a new state; it eases there over the next seconds (or jumps if `snap`). */
  setMood(time: number, storm: number, rain: number, snap = false) {
    this.goal.time = clamp(time, 0, 1); this.goal.storm = clamp(storm, 0, 1); this.goal.rain = clamp(rain, 0, 1);
    if (snap) { Object.assign(this.mood, this.goal); this.wet = this.goal.rain; this.baked.time = -1; }
  }

  private makeRain() {
    const N = 3600, pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      pos.set([x, y, z, x, y, z], i * 6); end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: timeU, uCenter: { value: new THREE.Vector3() }, uRain: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aEnd; uniform float uTime, uRain; uniform vec3 uCenter; varying float vA;
        void main(){
          vec3 p=position; float h=fract(sin(dot(p.xz,vec2(91.7,47.3)))*4375.5);
          p.y=fract(p.y-uTime*(0.85+h*0.4));
          vec3 w=vec3(uCenter.x+(p.x-0.5)*46.0, p.y*30.0-1.0, uCenter.z+(p.z-0.5)*46.0);
          w+=aEnd*vec3(0.16,1.0,0.05)*(0.7+h*0.6);
          vA=uRain*(0.16+0.3*h)*aEnd;
          gl_Position=projectionMatrix*viewMatrix*vec4(w,1.0);
        }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor=vec4(0.72,0.8,0.95,vA); }`,
    });
    this.rain = new THREE.LineSegments(g, m);
    this.rain.frustumCulled = false; this.rain.renderOrder = 12; this.rain.visible = false;
    this.scene.add(this.rain);
  }

  /** A lightning strike: sky flash, a hard light across the field and a visible bolt in front of the camera. */
  strike(cam?: THREE.Camera) {
    const az = cam ? Math.atan2(-cam.position.x, -cam.position.z) + randS(0.7) : rand(6.283), dist = rand(70, 120);
    const x = Math.sin(az) * dist, z = Math.cos(az) * dist;
    this.bolt.position.set(x * 0.5, 60, z * 0.5);
    const env = (t: number) => (t < 0.08 ? t / 0.08 : t < 0.2 ? 1 - (t - 0.08) * 6 : t < 0.3 ? 0.3 + (t - 0.2) * 6 : Math.max(0, 0.9 * (1 - (t - 0.3) / 0.7)));
    void tween(0.5, (t) => { const e = env(t); this.bolt.intensity = e * 7; SKY.uFlash.value = e * 2.2; });
    // Jagged ribbon that faces the origin, with one fork.
    const pts: number[] = [], idx: number[] = [], side = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const arm = (x0: number, y0: number, z0: number, y1: number, w: number, drift: number) => {
      let px = x0, pz = z0; const n = 14, base = pts.length / 3;
      for (let i = 0; i <= n; i++) {
        const y = lerp(y0, y1, i / n), ww = w * (1 - 0.6 * (i / n));
        pts.push(px - side.x * ww, y, pz - side.z * ww, px + side.x * ww, y, pz + side.z * ww);
        if (i < n) { const k = base + i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
        px += side.x * (randS(4) + drift); pz += side.z * (randS(4) + drift);
      }
    };
    arm(x, 95, z, 2, 0.55, 0); arm(x + side.x * randS(6), rand(45, 60), z + side.z * randS(6), rand(14, 26), 0.28, randS(3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); g.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3.4, 5), transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 7;
    this.scene.add(m);
    void tween(0.32, (t) => { mat.opacity = t < 0.3 ? 1 : t < 0.45 ? 0.2 : t < 0.6 ? 0.9 : 1 - (t - 0.6) / 0.4; }).then(() => { m.removeFromParent(); g.dispose(); mat.dispose(); });
    this.onThunder(dist / 160);
  }

  private applyMood(dt: number, focus: THREE.Vector3) {
    const m = this.mood, g = this.goal, ap = (a: number, b: number, rate: number) => a + clamp(b - a, -rate * dt, rate * dt);
    m.time = ap(m.time, g.time, 0.07); m.storm = ap(m.storm, g.storm, g.storm > m.storm ? 0.7 : 0.18); m.rain = ap(m.rain, g.rain, 0.25);
    this.wet = ap(this.wet, m.rain, m.rain > this.wet ? 0.12 : 0.03);
    const t = m.time, a = t < 0.5 ? DAWN : NOON, b = t < 0.5 ? NOON : DUSK, k = smooth(t < 0.5 ? t * 2 : t * 2 - 1), s = m.storm;
    const L = (key: keyof Key) => lerp(a[key] as number, b[key] as number, k);
    const C3 = (key: keyof Key, out: THREE.Vector3, st: number[], sk = s) => { const x = a[key] as number[], y = b[key] as number[]; out.set(lerp(lerp(x[0], y[0], k), st[0], sk), lerp(lerp(x[1], y[1], k), st[1], sk), lerp(lerp(x[2], y[2], k), st[2], sk)); };
    C3('zen', SKY.uZen.value, [0.03, 0.04, 0.06]); C3('mid', SKY.uMid.value, [0.07, 0.08, 0.11]); C3('hor', SKY.uHor.value, [0.13, 0.14, 0.18]);
    C3('horSun', SKY.uHorSun.value, [0.2, 0.2, 0.24]); C3('cloudA', SKY.uCloudA.value, [0.045, 0.05, 0.065]); C3('cloudB', SKY.uCloudB.value, [0.2, 0.21, 0.25]);
    C3('sunCol', SKY.uSunCol.value, [0.5, 0.56, 0.7]);
    SKY.uStars.value = L('stars') * (1 - s); SKY.uCover.value = s;
    C3('sun', tmpV, [0, 0, 0], 0); SUN_DIR.copy(tmpV).normalize();
    this.sun.position.copy(SUN_DIR).multiplyScalar(70);
    river.mood(m.time, s, m.rain, SUN_DIR);
    C3('light', tmpV, [0.45, 0.52, 0.72]); this.sun.color.setRGB(tmpV.x, tmpV.y, tmpV.z);
    this.sun.intensity = L('sunInt') * (1 - 0.82 * s);
    C3('hemiSky', tmpV, [0.2, 0.25, 0.36]); this.hemi.color.setRGB(tmpV.x, tmpV.y, tmpV.z);
    C3('hemiGnd', tmpV, [0.08, 0.08, 0.1]); this.hemi.groundColor.setRGB(tmpV.x, tmpV.y, tmpV.z);
    this.hemi.intensity = L('hemiInt') * (1 - 0.3 * s); this.rim.intensity = L('rimInt') * (1 - 0.5 * s);
    C3('fog', tmpV, [0.085, 0.1, 0.135], s * 0.9); FOG.setRGB(tmpV.x, tmpV.y, tmpV.z);
    (this.scene.fog as THREE.FogExp2).density = L('fogDen') * (1 + 1.1 * s) * (1 + 0.6 * m.rain);
    this.scene.environmentIntensity = L('env') * (1 - 0.45 * s) + this.wet * 0.25;
    this.exposure = L('exposure') * (1 - 0.1 * s);
    this.rayGain = L('rays') * (1 - s);
    this.mist = L('mist');
    for (const top of this.tops) { top.roughness = lerp(0.78, 0.32, this.wet); top.metalness = lerp(0.05, 0.3, this.wet); }
    // One bake per storm front (as it crosses the half-way mark), and one per eighth of the day.
    if (Math.abs(m.time - this.baked.time) > 0.12 || (m.storm > 0.5 ? 1 : 0) !== this.baked.storm) this.bakeEnv();

    // Rain streaks follow the camera's focus; splashes dot the terrace.
    const ru = (this.rain.material as THREE.ShaderMaterial).uniforms;
    this.rain.visible = m.rain > 0.01; ru.uRain.value = m.rain; ru.uCenter.value.copy(focus);
    this.rain.geometry.setDrawRange(0, Math.floor(3600 * quality.s.rain * Math.min(1, m.rain * 1.2)) * 2);
    for (let i = 0, n = m.rain * 90 * dt; i < n; i++) {
      if (n - i < 1 && Math.random() > n - i) break;
      fx.alpha.emit({ x: focus.x + randS(11), y: 0.03, z: focus.z + randS(11), life: 0.28, size: 0.06, size2: 0.4, c: 0xd6e4ff, a: 0.3 });
    }
    // Random lightning while the storm holds.
    if (s > 0.55 && !this.quiet) { this.nextStrike -= dt; if (this.nextStrike <= 0) { this.nextStrike = rand(3.5, 8); this.strike(this.cam); } }
  }
  private rayGain = 1;
  private mist = 1;
  cam?: THREE.Camera;

  update(t: number, dt: number, focus: THREE.Vector3 = ORIGIN) {
    this.applyMood(dt, focus);
    river.update();
    const ease = Math.min(1, Math.max(dt, 1 / 120) * 12); // hit-stop must not freeze a dipping flag
    for (const f of this.flags) {
      const hid = !!this.cam && blocksSight(f.g.position.x, 3.4, f.g.position.z, 2.6, this.cam.position, focus);
      f.dip += ((hid ? 1 : 0) - f.dip) * ease;
      f.g.position.y = -0.1 - 5 * smooth(f.dip);
    }
    for (const b of this.braziers) {
      if (Math.random() < dt * 40) fx.fire(b.pos, 1, 0.8);
      if (Math.random() < dt * 5) fx.embers(b.pos, 1, 0xff8a30, 0.15, 2.4);
      if (b.light) b.light.intensity = 26 + Math.sin(t * 11 + b.seed) * 5 + Math.sin(t * 23 + b.seed * 3) * 4;
    }
    for (const r of this.rays) (r.material as THREE.MeshBasicMaterial).opacity = (0.04 + 0.025 * Math.sin(t * 0.4 + r.userData.ph)) * this.rayGain;
    this.acc += dt;
    const gap = 0.12 / this.mist;
    while (this.acc > gap) {
      this.acc -= gap;
      // River mist and drifting motes
      fx.alpha.emit({ x: randS(15), y: WATER_Y + 0.25, z: randS(1.1), vx: rand(0.2, 0.7), vy: 0.05, life: rand(5, 8), size: 1.6, size2: 3.6, c: 0xcfd6e6, a: 0.06, fadeIn: true });
      fx.add.emit({ x: randS(13), y: rand(0.3, 4), z: randS(13), vx: randS(0.2), vy: rand(0.05, 0.25), vz: randS(0.2), life: rand(3, 6), size: rand(0.04, 0.09), size2: 0.02, c: 0xffc070, a: 0.7, fadeIn: true });
    }
  }
}
