// Visual effects: pooled particles, shockwaves, slash arcs, light flashes and rigid debris.
import * as THREE from 'three';
import { disposeTree, ease, groundHeight, rand, randS, terraceInset, tween, WATER_Y } from './core';
import { quality } from './quality';

interface Emit {
  x: number; y: number; z: number; vx?: number; vy?: number; vz?: number;
  life: number; size: number; size2?: number;
  c: THREE.ColorRepresentation; c2?: THREE.ColorRepresentation; a?: number;
  grav?: number; drag?: number; fadeIn?: boolean;
}

const VERT = /* glsl */ `
attribute float aSize; attribute vec4 aColor; varying vec4 vColor; uniform float uScale;
void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  gl_PointSize=min(aSize*uScale/max(0.1,-mv.z), 512.0); }`;
const FRAG = /* glsl */ `
varying vec4 vColor; uniform float uSoft;
void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,uSoft,d); if(a<0.003) discard;
  gl_FragColor=vec4(vColor.rgb, vColor.a*a); }`;

const tc = new THREE.Color(), tc2 = new THREE.Color();

class PSys {
  points: THREE.Points;
  private n: number; private cur = 0;
  /** Live pool size (<= n) and share of emits kept, both set by the quality tier. */
  private limit: number; keep = 1;
  private pos: Float32Array; private col: Float32Array; private size: Float32Array;
  private vel: Float32Array; private c0: Float32Array; private c1: Float32Array;
  private life: Float32Array; private age: Float32Array; private s0: Float32Array; private s1: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private alpha: Float32Array; private fin: Uint8Array;
  mat: THREE.ShaderMaterial;

  constructor(n: number, additive: boolean) {
    this.n = this.limit = n;
    const f = (k: number) => new Float32Array(n * k);
    this.pos = f(3); this.col = f(4); this.size = f(1); this.vel = f(3); this.c0 = f(3); this.c1 = f(3);
    this.life = f(1); this.age = f(1); this.s0 = f(1); this.s1 = f(1); this.grav = f(1); this.drag = f(1); this.alpha = f(1);
    this.fin = new Uint8Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 800 }, uSoft: { value: additive ? 0.0 : 0.15 } },
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
  }

  /** Shrink or restore the pool to `share` of its full size and thin out emits to match. */
  setBudget(share: number) {
    this.keep = share; this.limit = Math.max(1, Math.round(this.n * share)); this.cur %= this.limit;
    for (let i = this.limit; i < this.n; i++) { this.life[i] = 0; this.size[i] = 0; this.col[i * 4 + 3] = 0; }
    this.points.geometry.setDrawRange(0, this.limit);
  }

  emit(e: Emit) {
    if (this.keep < 1 && Math.random() > this.keep) return;
    const i = this.cur; this.cur = (this.cur + 1) % this.limit;
    this.pos[i * 3] = e.x; this.pos[i * 3 + 1] = e.y; this.pos[i * 3 + 2] = e.z;
    this.vel[i * 3] = e.vx ?? 0; this.vel[i * 3 + 1] = e.vy ?? 0; this.vel[i * 3 + 2] = e.vz ?? 0;
    tc.set(e.c); tc2.set(e.c2 ?? e.c);
    this.c0[i * 3] = tc.r; this.c0[i * 3 + 1] = tc.g; this.c0[i * 3 + 2] = tc.b;
    this.c1[i * 3] = tc2.r; this.c1[i * 3 + 1] = tc2.g; this.c1[i * 3 + 2] = tc2.b;
    this.life[i] = e.life; this.age[i] = 0; this.s0[i] = e.size; this.s1[i] = e.size2 ?? e.size;
    this.grav[i] = e.grav ?? 0; this.drag[i] = e.drag ?? 0; this.alpha[i] = e.a ?? 1; this.fin[i] = e.fadeIn ? 1 : 0;
  }

  update(dt: number) {
    const { pos, vel, col, size, life, age, limit } = this;
    for (let i = 0; i < limit; i++) {
      if (life[i] <= 0) continue;
      age[i] += dt;
      const t = age[i] / life[i];
      if (t >= 1) { life[i] = 0; size[i] = 0; col[i * 4 + 3] = 0; continue; }
      const k = Math.max(0, 1 - this.drag[i] * dt);
      const j = i * 3;
      vel[j] *= k; vel[j + 1] = vel[j + 1] * k - this.grav[i] * dt; vel[j + 2] *= k;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const q = i * 4;
      col[q] = this.c0[j] + (this.c1[j] - this.c0[j]) * t;
      col[q + 1] = this.c0[j + 1] + (this.c1[j + 1] - this.c0[j + 1]) * t;
      col[q + 2] = this.c0[j + 2] + (this.c1[j + 2] - this.c0[j + 2]) * t;
      col[q + 3] = this.alpha[i] * (this.fin[i] ? Math.sin(Math.PI * t) : 1 - t * t);
    }
    const g = this.points.geometry;
    for (const [k, w] of [['position', 3], ['aColor', 4], ['aSize', 1]] as const) {
      const a = g.attributes[k] as THREE.BufferAttribute;
      a.clearUpdateRanges(); a.addUpdateRange(0, limit * w); a.needsUpdate = true;
    }
  }
}

interface Debris { o: THREE.Object3D; v: THREE.Vector3; w: THREE.Vector3; life: number; r: number; smoke: boolean; keep: boolean; stick: number; tag: number }
export interface DebrisOpts { smoke?: boolean; /** stay on the battlefield once it comes to rest */ keep?: boolean; /** local Y of a weapon tip: plant it in the ground on landing */ stick?: number }

class FX {
  scene!: THREE.Scene;
  add = new PSys(7000, true); // additive: fire, sparks, magic
  alpha = new PSys(4000, false); // alpha blended: dust, smoke, water
  private flashes: THREE.PointLight[] = [];
  private flashI = 0;
  private debrisList: Debris[] = [];
  private crescent = makeCrescent();
  private ringGeo = new THREE.RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
  private pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
  private pillarTex = (() => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 128;
    const g = c.getContext('2d')!, gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = gr; g.fillRect(0, 0, 8, 128);
    return new THREE.CanvasTexture(c);
  })();
  private rockGeo = (() => { const g = new THREE.DodecahedronGeometry(1, 0); g.userData.shared = true; return g; })();
  private rockMat = new THREE.MeshStandardMaterial({ color: 0x6f6759, roughness: 0.95 });
  /** Called when a kept fragment comes to rest; the owner takes over its lifetime. */
  onRest: (o: THREE.Object3D, tag: number) => void = () => {};
  /** Stamped on every fragment at launch (the move number), so late landings are attributed correctly. */
  tag = 0;

  init(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.add.points, this.alpha.points);
    this.applyQuality();
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 22, 1.6);
      scene.add(l); this.flashes.push(l);
    }
  }

  /** Particle budgets follow the quality tier. */
  applyQuality() { this.add.setBudget(quality.s.particles); this.alpha.setBudget(quality.s.particles); }

  setViewport(heightPx: number, fovDeg: number) {
    const s = (heightPx * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
    this.add.mat.uniforms.uScale.value = s; this.alpha.mat.uniforms.uScale.value = s;
  }

  update(dt: number) {
    this.add.update(dt); this.alpha.update(dt);
    for (let i = this.debrisList.length - 1; i >= 0; i--) {
      const d = this.debrisList[i];
      d.life -= dt;
      d.v.y -= 16 * dt;
      d.o.position.addScaledVector(d.v, dt);
      const wl = d.w.length();
      if (wl > 1e-4) d.o.rotateOnWorldAxis(tv.copy(d.w).divideScalar(wl), wl * dt);
      const gy = groundHeight(d.o.position.x, d.o.position.z) + d.r;
      if (d.o.position.y < gy) {
        d.o.position.y = gy;
        if (d.v.y < -2.5) this.dust(d.o.position, 4, 0.6);
        const solid = terraceInset(d.o.position.x, d.o.position.z) > 0.25;
        if (d.stick && solid) { // weapon buries its head in the ground
          const dir = tv.set(d.v.x * 0.12 + randS(0.3), -1, d.v.z * 0.12 + randS(0.3)).normalize();
          d.o.quaternion.setFromUnitVectors(UP, dir);
          this.sparks(tv2.set(d.o.position.x, 0.1, d.o.position.z), null, 8, 0xffe0a0, 3);
          d.o.position.set(d.o.position.x, -0.15, d.o.position.z).addScaledVector(dir, -d.stick * d.o.scale.y);
          this.debrisList.splice(i, 1); this.onRest(d.o, d.tag); continue;
        }
        if (d.keep && solid && d.v.y > -3.2) { this.debrisList.splice(i, 1); this.onRest(d.o, d.tag); continue; }
        if ((d.keep || d.stick) && !solid) { d.keep = false; d.stick = 0; d.life = Math.min(d.life, 0.8); }
        d.v.y *= -0.38; d.v.x *= 0.62; d.v.z *= 0.62; d.w.multiplyScalar(0.6);
      }
      if (d.smoke && Math.random() < 0.5) this.smoke(d.o.position, 1, 0.5);
      if (d.life < 0.35) d.o.scale.multiplyScalar(Math.max(0, 1 - dt * 7));
      if (d.life <= 0) { disposeTree(d.o); this.debrisList.splice(i, 1); }
    }
  }

  clearDebris() { for (const d of this.debrisList) disposeTree(d.o); this.debrisList.length = 0; }

  /** Detach an object into world space and let it fly as a rigid fragment. */
  debris(o: THREE.Object3D, v: THREE.Vector3, spin = 8, life = 2.2, opts: boolean | DebrisOpts = false) {
    this.scene.attach(o);
    const op = typeof opts === 'boolean' ? { smoke: opts } : opts;
    const w = new THREE.Vector3(randS(), randS(), randS()).normalize().multiplyScalar(spin);
    this.debrisList.push({ o, v: v.clone(), w, life: op.keep || op.stick ? Math.max(life, 5) : life, r: 0.12, smoke: !!op.smoke, keep: !!op.keep, stick: op.stick ?? 0, tag: this.tag });
  }

  flash(p: THREE.Vector3, color: THREE.ColorRepresentation, intensity = 60, dur = 0.5) {
    const l = this.flashes[this.flashI++ % this.flashes.length];
    l.color.set(color); l.position.copy(p).setY(p.y + 1.2);
    tween(dur, (t) => { l.intensity = intensity * (1 - t) * (1 - t); });
  }

  shockwave(p: THREE.Vector3, color: THREE.ColorRepresentation, radius = 4, dur = 0.7, y = 0.06) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.position.set(p.x, groundHeight(p.x, p.z) + y, p.z);
    m.renderOrder = 9;
    this.scene.add(m);
    tween(dur, (t) => { m.scale.setScalar(0.2 + radius * t); m.material.opacity = (1 - t) * (1 - t); }, ease.out3)
      .then(() => { m.removeFromParent(); m.material.dispose(); });
  }

  /** Glowing crescent that travels along `dir`. */
  slash(p: THREE.Vector3, dir: THREE.Vector3, color: THREE.ColorRepresentation, o: { vertical?: boolean; size?: number; travel?: number; dur?: number; tilt?: number } = {}) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(this.crescent, new THREE.MeshBasicMaterial({
      color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    if (!o.vertical) m.rotation.x = -Math.PI / 2 + (o.tilt ?? 0);
    g.add(m);
    g.rotation.y = Math.atan2(-dir.z, dir.x);
    g.position.copy(p);
    const size = o.size ?? 1.4, travel = o.travel ?? 2.2;
    this.scene.add(g);
    const start = p.clone();
    tween(o.dur ?? 0.38, (t) => {
      g.position.copy(start).addScaledVector(dir, travel * t);
      g.scale.setScalar(size * (0.6 + 0.7 * t));
      m.material.opacity = 1 - t * t;
      if (Math.random() < 0.8) this.add.emit({ x: g.position.x + randS(0.5), y: g.position.y + randS(0.5), z: g.position.z + randS(0.5), life: 0.35, size: 0.14, size2: 0, c: color });
    }, ease.out2).then(() => { g.removeFromParent(); m.material.dispose(); });
  }

  /** Column of light that slams down and thins out: the moment a unit is destroyed. */
  pillar(p: THREE.Vector3, color: THREE.ColorRepresentation, height = 10, radius = 1.0, dur = 0.9) {
    const m = new THREE.Mesh(this.pillarGeo, new THREE.MeshBasicMaterial({
      color, map: this.pillarTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    m.position.set(p.x, groundHeight(p.x, p.z), p.z); m.renderOrder = 9;
    this.scene.add(m);
    tween(dur, (t) => { const w = radius * (1.0 - 0.85 * ease.out3(t)); m.scale.set(w, height * (0.5 + 0.5 * ease.out3(Math.min(1, t * 4))), w); m.material.opacity = 0.55 * (1 - t * t); m.rotation.y = t * 2; })
      .then(() => { m.removeFromParent(); m.material.dispose(); });
    this.flash(p, color, 45, dur * 0.6);
  }

  /** Chunks of paving thrown up by a heavy impact. */
  rubble(p: THREE.Vector3, n = 8, power = 1) {
    n = Math.max(1, Math.round(n * quality.s.debris));
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.rockGeo, this.rockMat);
      const a = rand(Math.PI * 2), r = rand(0.2, 0.7);
      m.position.set(p.x + Math.cos(a) * r, groundHeight(p.x, p.z) + 0.1, p.z + Math.sin(a) * r);
      m.scale.set(rand(0.08, 0.26), rand(0.06, 0.18), rand(0.08, 0.26)).multiplyScalar(power);
      m.castShadow = true;
      this.debris(m, tv.set(Math.cos(a) * rand(1.5, 5), rand(4, 9), Math.sin(a) * rand(1.5, 5)).multiplyScalar(Math.sqrt(power)), rand(5, 14), rand(1.0, 1.8));
    }
  }

  /** The unit's glyph lifts off, swells and burns away. */
  ghost(map: THREE.Texture | null, p: THREE.Vector3, height: number) {
    if (!map) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    s.renderOrder = 21; this.scene.add(s);
    tween(1.5, (t) => { const k = ease.out3(t); s.position.set(p.x, p.y + height + 0.4 + k * 2.6, p.z); s.scale.setScalar(0.7 + 2.3 * k); s.material.opacity = 1 - t * t * t; s.material.rotation = (1 - k) * 0.5; })
      .then(() => { s.removeFromParent(); s.material.dispose(); });
  }

  // ----- particle recipes -----
  dust(p: THREE.Vector3, n = 10, power = 1, color: THREE.ColorRepresentation = 0xa08a66) {
    if (p.y < WATER_Y + 0.1 && groundHeight(p.x, p.z) < WATER_Y) { this.splash(p, n, power); return; }
    for (let i = 0; i < n; i++) {
      const a = rand(Math.PI * 2), s = rand(0.6, 2.2) * power;
      this.alpha.emit({ x: p.x + Math.cos(a) * 0.2, y: p.y + 0.08, z: p.z + Math.sin(a) * 0.2, vx: Math.cos(a) * s, vy: rand(0.3, 1.2) * power, vz: Math.sin(a) * s,
        life: rand(0.6, 1.3), size: rand(0.3, 0.5) * power, size2: rand(1.0, 1.7) * power, c: color, c2: 0x6f6252, a: 0.42, drag: 2.2, grav: -0.2 });
    }
  }

  splash(p: THREE.Vector3, n = 10, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = rand(Math.PI * 2), s = rand(0.4, 1.8) * power;
      this.alpha.emit({ x: p.x + Math.cos(a) * 0.25, y: WATER_Y + 0.05, z: p.z + Math.sin(a) * 0.25, vx: Math.cos(a) * s, vy: rand(2, 4.5) * power, vz: Math.sin(a) * s,
        life: rand(0.5, 0.9), size: rand(0.1, 0.22), size2: 0.05, c: 0xe8f6ff, c2: 0x9fd0e8, a: 0.85, grav: 11 });
    }
    for (let i = 0; i < n / 3; i++)
      this.alpha.emit({ x: p.x + randS(0.4), y: WATER_Y + 0.03, z: p.z + randS(0.4), life: 0.9, size: 0.4, size2: 1.6, c: 0xffffff, a: 0.3 });
  }

  sparks(p: THREE.Vector3, dir: THREE.Vector3 | null, n = 24, color: THREE.ColorRepresentation = 0xffc060, speed = 7) {
    for (let i = 0; i < n; i++) {
      tv.set(randS(), rand(-0.2, 1), randS()).normalize();
      if (dir) tv.addScaledVector(dir, 0.9).normalize();
      const s = rand(0.3, 1) * speed;
      this.add.emit({ x: p.x, y: p.y, z: p.z, vx: tv.x * s, vy: tv.y * s, vz: tv.z * s, life: rand(0.25, 0.7), size: rand(0.06, 0.14), size2: 0, c: 0xffffff, c2: color, grav: 9, drag: 1.5 });
    }
  }

  fire(p: THREE.Vector3, n = 6, scale = 1, c: THREE.ColorRepresentation = 0xffb040, c2: THREE.ColorRepresentation = 0xd02000) {
    for (let i = 0; i < n; i++)
      this.add.emit({ x: p.x + randS(0.12 * scale), y: p.y + rand(0.1 * scale), z: p.z + randS(0.12 * scale), vx: randS(0.25 * scale), vy: rand(0.8, 1.9) * scale, vz: randS(0.25 * scale),
        life: rand(0.35, 0.8), size: rand(0.3, 0.5) * scale, size2: 0.05, c, c2, a: 0.32 });
  }

  smoke(p: THREE.Vector3, n = 4, scale = 1, c: THREE.ColorRepresentation = 0x3a3634) {
    for (let i = 0; i < n; i++)
      this.alpha.emit({ x: p.x + randS(0.25 * scale), y: p.y + rand(0.3) * scale, z: p.z + randS(0.25 * scale), vx: randS(0.5), vy: rand(0.6, 1.6), vz: randS(0.5),
        life: rand(1.2, 2.4), size: rand(0.4, 0.7) * scale, size2: rand(1.6, 2.6) * scale, c, c2: 0x8a8480, a: 0.4, drag: 0.6, fadeIn: true });
  }

  embers(p: THREE.Vector3, n = 10, color: THREE.ColorRepresentation = 0xff9030, spread = 0.5, rise = 1.6) {
    for (let i = 0; i < n; i++)
      this.add.emit({ x: p.x + randS(spread), y: p.y + rand(spread * 1.5), z: p.z + randS(spread), vx: randS(0.5), vy: rand(0.5, 1) * rise, vz: randS(0.5),
        life: rand(0.8, 1.8), size: rand(0.05, 0.13), size2: 0, c: color, drag: 0.4, fadeIn: true });
  }

  /** Converging motes, used for charging up. */
  gather(p: THREE.Vector3, n: number, color: THREE.ColorRepresentation, radius = 1.4) {
    for (let i = 0; i < n; i++) {
      tv.set(randS(), randS(), randS()).normalize().multiplyScalar(radius);
      const life = rand(0.25, 0.45);
      this.add.emit({ x: p.x + tv.x, y: p.y + tv.y, z: p.z + tv.z, vx: -tv.x / life, vy: -tv.y / life, vz: -tv.z / life, life, size: 0.05, size2: 0.16, c: color, fadeIn: true });
    }
  }

  glow(p: THREE.Vector3, color: THREE.ColorRepresentation, size = 0.3, life = 0.3, a = 0.8) {
    this.add.emit({ x: p.x, y: p.y, z: p.z, life, size, size2: size * 0.2, c: color, a });
  }

  explosion(p: THREE.Vector3, scale = 1) {
    const y = p.y + 0.5;
    for (let i = 0; i < 70 * scale; i++) {
      tv.set(randS(), rand(-0.1, 1), randS()).normalize().multiplyScalar(rand(1, 7) * scale);
      this.add.emit({ x: p.x, y, z: p.z, vx: tv.x, vy: tv.y, vz: tv.z, life: rand(0.35, 0.9), size: rand(0.6, 1.3) * scale, size2: 0.1, c: 0xfff0b0, c2: 0xe03000, a: 0.6, drag: 3 });
    }
    for (let i = 0; i < 26 * scale; i++) {
      tv.set(randS(), rand(0, 1), randS()).normalize().multiplyScalar(rand(0.5, 3) * scale);
      this.alpha.emit({ x: p.x, y, z: p.z, vx: tv.x, vy: tv.y + 1, vz: tv.z, life: rand(1.4, 2.8), size: rand(0.8, 1.2) * scale, size2: rand(2.5, 4) * scale, c: 0x1c1a19, c2: 0x7a746e, a: 0.55, drag: 1.4, fadeIn: true });
    }
    this.sparks(tv2.set(p.x, y, p.z), null, 60 * scale, 0xff8020, 13);
    this.flash(p, 0xffa040, 160 * scale, 0.7);
    this.shockwave(p, 0xffc070, 5.5 * scale, 0.6);
    this.shockwave(p, 0xff5010, 3.2 * scale, 0.9, 0.09);
  }

  /** Dissolve a volume into rising motes. */
  soul(p: THREE.Vector3, height: number, color: THREE.ColorRepresentation, n = 60, radius = 0.5) {
    for (let i = 0; i < n; i++) {
      const a = rand(Math.PI * 2), r = rand(radius);
      this.add.emit({ x: p.x + Math.cos(a) * r, y: p.y + rand(height), z: p.z + Math.sin(a) * r, vx: randS(0.4), vy: rand(0.6, 2.4), vz: randS(0.4),
        life: rand(0.7, 1.7), size: rand(0.06, 0.2), size2: 0, c: color, c2: 0xffffff, drag: 0.5, fadeIn: true });
    }
  }
}

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

/** Tapered crescent in the XY plane, bulging towards +X. */
function makeCrescent(): THREE.BufferGeometry {
  const N = 28, A = 1.25, pos: number[] = [], index: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, th = -A + 2 * A * u, w = 0.34 * Math.pow(Math.sin(Math.PI * u), 0.8);
    pos.push(Math.cos(th), Math.sin(th), 0, Math.cos(th) * (1 - w) - w * 0.4, Math.sin(th) * (1 - w * 0.3), 0);
    if (i < N) { const k = i * 2; index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.translate(-0.6, 0, 0);
  return g;
}

export const fx = new FX();
