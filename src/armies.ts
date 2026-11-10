// The reserves: each army's ranks, war drums, banners and torches behind its back rank. Everything they
// do is a function of the position (morale, check, the result) plus the clock; only a cheer after a
// capture and the first moments of the finale are transient, and resetState() drops those.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Side } from './engine';
import { clamp, clock, lerp, smooth } from './core';
import { fx } from './fx';
import { sfx } from './audio';
import { box, clothMat, cone, cyl, glyphTexture, sph, TEAM } from './kit';
import { TIERS, type Settings, type Tier } from './quality';

/** Ranks per tier: rows deep, men per row (split either side of the central aisle), spacing, model detail. */
const RANKS: Record<Tier, { rows: number; per: number; gap: number; lo: boolean }> = {
  high: { rows: 4, per: 20, gap: 1.0, lo: false },
  mid: { rows: 4, per: 16, gap: 1.22, lo: false },
  low: { rows: 3, per: 14, gap: 1.38, lo: true },
};
const GROUND = -0.1, FRONT = 12.9, ROW = 1.12, AISLE = 2.5, BACK = 20.6;
const hash = (i: number, k: number) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };
const C = new THREE.Color();

// ---------- geometry: vertex-coloured low-poly pieces, merged per figure ----------
/** Non-indexed copy of `g` painted one colour; part 1 marks the arm that the shader can raise. */
function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, part = 0) {
  const n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  const k = n.attributes.position.count, col = new Float32Array(k * 3), p = new Float32Array(k).fill(part);
  C.set(color);
  for (let i = 0; i < k; i++) col.set([C.r, C.g, C.b], i * 3);
  n.setAttribute('color', new THREE.BufferAttribute(col, 3)); n.setAttribute('aPart', new THREE.BufferAttribute(p, 1));
  n.deleteAttribute('uv');
  return n;
}
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);
function merge(parts: THREE.BufferGeometry[]) { const g = mergeGeometries(parts)!; for (const p of parts) p.dispose(); return g; }

/** A soldier facing +z: spear in the right hand (the raisable part), shield on the left. ~140 / ~70 triangles. */
function soldierGeo(side: Side, lo: boolean) {
  const T = TEAM[side], seg = lo ? 4 : 6;
  const parts = [
    paint(at(box(0.3, 0.55, 0.2), 0, 0.275, 0), 0x2a2420),
    paint(at(cyl(0.17, 0.27, 0.62, seg), 0, 0.83, 0), T.main),
    paint(at(box(0.5, 0.1, 0.22), 0, 1.1, 0), T.trim),
    paint(at(sph(0.12, lo ? 4 : 6, lo ? 3 : 4), 0, 1.26, 0), 0xd2a07a),
    side === 'r' ? paint(at(cone(0.3, 0.15, lo ? 5 : 7), 0, 1.4, 0), 0xb08850) : paint(at(cone(0.16, 0.34, lo ? 4 : 6), 0, 1.46, 0), 0x2b313a),
    paint(at(box(0.09, 0.42, 0.09), 0.27, 0.92, 0.04), T.main, 1),
    paint(at(box(0.035, 2.1, 0.035), 0.3, 1.2, 0.1), 0x5a3d24, 1),
    paint(at(cone(0.05, 0.22, 4), 0.3, 2.36, 0.1), 0xc8ccd2, 1),
  ];
  if (!lo) parts.push(paint(at(cyl(0.21, 0.21, 0.05, 7).rotateX(Math.PI / 2), -0.27, 0.86, 0.13), T.dark));
  return merge(parts);
}
/** A drummer facing +z, both sticks reaching forward (the raisable part). */
function drummerGeo(side: Side) {
  const T = TEAM[side];
  return merge([
    paint(at(box(0.32, 0.55, 0.22), 0, 0.275, 0), 0x2a2420),
    paint(at(cyl(0.19, 0.29, 0.64, 6), 0, 0.84, 0), T.main),
    paint(at(sph(0.13, 6, 4), 0, 1.3, 0), 0xd2a07a),
    paint(at(box(0.36, 0.1, 0.36), 0, 1.42, 0), 0xc23a2a),
    ...[-1, 1].flatMap((sx) => [paint(at(box(0.09, 0.09, 0.42), sx * 0.22, 1.02, 0.22), T.main, 1), paint(at(box(0.04, 0.04, 0.55), sx * 0.22, 1.0, 0.6), 0x3a2414, 1)]),
  ]);
}
/** A war drum on its stand, the near skin tilted up towards a drummer standing at local z = -0.9. */
function drumGeo(side: Side) {
  const T = TEAM[side], rx = (g: THREE.BufferGeometry) => g.rotateX(Math.PI / 2);
  const drum = [
    paint(rx(cyl(0.5, 0.5, 0.6, 14)), T.main), paint(rx(at(cyl(0.47, 0.47, 0.04, 14), 0, 0.31, 0)), 0xe6d6b0), paint(rx(at(cyl(0.47, 0.47, 0.04, 14), 0, -0.31, 0)), 0xe6d6b0),
    paint(rx(at(cyl(0.53, 0.53, 0.06, 14), 0, 0.27, 0)), T.trim), paint(rx(at(cyl(0.53, 0.53, 0.06, 14), 0, -0.27, 0)), T.trim),
  ].map((g) => g.rotateX(0.55).translate(0, 0.98, 0));
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => paint(at(box(0.08, 0.8, 0.08), sx * 0.42, 0.4, sz * 0.27), 0x4a3220)));
  return merge([...drum, ...legs, paint(at(box(0.98, 0.07, 0.66), 0, 0.5, 0), 0x4a3220)]);
}
function poleGeo(h: number, trim: number) {
  return merge([paint(at(cyl(0.06, 0.09, h, 6), 0, h / 2, 0), 0x4e3420), paint(at(sph(0.13, 6, 4), 0, h + 0.08, 0), trim), paint(at(box(0.08, 0.08, 0.5), 0, h - 0.3, 0), 0x4e3420)]);
}
const torchGeo = () => merge([paint(at(cyl(0.04, 0.05, 2.2, 5), 0, 1.1, 0), 0x3a2a1c), paint(at(cyl(0.16, 0.09, 0.18, 6), 0, 2.25, 0), 0x2a2826)]);

/** Lifts and swings the arm part: aArm.x raises it, aArm.y turns it about the shoulder (negative = up). */
function armShader(m: THREE.Material) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec2 aArm; attribute float aPart;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      if (aPart > 0.5) {
        vec3 q = transformed - vec3(0.0, 1.1, 0.04); float c = cos(aArm.y), s = sin(aArm.y);
        transformed = vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c) + vec3(0.0, 1.1 + aArm.x, 0.04);
      }`);
  };
  m.customProgramCacheKey = () => 'army-arm';
  return m;
}

// ---------- state ----------
interface Man { x: number; z: number; ph: number; drop: number; flee: number; jit: number }
interface Banner { g: THREE.Group; flag: THREE.Mesh; top: number; tilt: number }
interface Host {
  side: Side; s: number; yaw: number;
  men: Man[]; ranks?: THREE.InstancedMesh; arm?: THREE.InstancedBufferAttribute;
  drummers: THREE.InstancedMesh; darm: THREE.InstancedBufferAttribute; drums: THREE.Mesh[];
  banners: Banner[]; wind: { value: number }; torches: THREE.Vector3[];
  /** Morale as shown (eased towards the position's value). */
  shown: number; target: number;
}

/** Envelope of a cheer `a` seconds after it began: up fast, hold, die away over a few seconds. */
const env = (a: number) => (a < 0 ? 0 : clamp(a / 0.2, 0, 1) * (1 - smooth(clamp((a - 2.6) / 2.6, 0, 1))));

class Armies {
  private scene!: THREE.Scene;
  private hosts: Record<Side, Host> = {} as Record<Side, Host>;
  private mat = armShader(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
  private depth = armShader(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  private prop = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7 });
  private torchPoles!: THREE.InstancedMesh;
  private flames!: THREE.InstancedMesh;
  private tier: Tier | '' = '';
  private check: Side | null = null;
  private over = false;
  private winner: Side | null = null;
  /** When the end began (clock time); far in the past for a finished position shown instantly. */
  private overT = -1e9;
  private cheerEv: { side: Side; t0: number } | null = null;
  private o = new THREE.Object3D();

  init(scene: THREE.Scene, s: Settings) {
    this.scene = scene;
    for (const side of ['r', 'b'] as const) this.hosts[side] = this.host(side);
    const all = Object.values(this.hosts).flatMap((h) => h.torches);
    this.torchPoles = new THREE.InstancedMesh(torchGeo(), this.prop, all.length);
    this.flames = new THREE.InstancedMesh(cone(0.15, 0.5, 5).translate(0, 0.25, 0), new THREE.MeshBasicMaterial({ color: 0xffa040 }), all.length);
    all.forEach((p, i) => { this.o.position.copy(p).setY(GROUND); this.o.scale.setScalar(1); this.o.rotation.set(0, 0, 0); this.o.updateMatrix(); this.torchPoles.setMatrixAt(i, this.o.matrix); });
    this.flames.frustumCulled = false; this.flames.castShadow = false;
    scene.add(this.torchPoles, this.flames);
    this.applyQuality(s);
  }

  private host(side: Side): Host {
    const s = side === 'r' ? 1 : -1, yaw = side === 'r' ? Math.PI : 0, T = TEAM[side];
    // Drummers in the aisle, their drums in front of them.
    const drums: THREE.Mesh[] = [], dgeo = drumGeo(side);
    for (const x of [-1.25, 1.25]) {
      const d = new THREE.Mesh(dgeo, this.prop);
      d.position.set(x, GROUND, s * 12.4); d.rotation.y = yaw; d.userData.x = x;
      this.scene.add(d); drums.push(d);
    }
    dgeo.userData.shared = true;
    const dg = drummerGeo(side), darm = new THREE.InstancedBufferAttribute(new Float32Array(4), 2);
    dg.setAttribute('aArm', darm);
    const drummers = new THREE.InstancedMesh(dg, this.mat, 2);
    drummers.customDepthMaterial = this.depth; drummers.frustumCulled = false;
    this.scene.add(drummers);
    // Banners: two on the flanks of the front rank, two deep by the fortress wall.
    const wind = { value: 1 };
    const tex = glyphTexture(side === 'r' ? '漢' : '楚', { w: 256, h: 160, bg: side === 'r' ? '#a51e18' : '#1b2636', fg: '#f6d27a', size: 120, border: '#e2b04a' });
    const flagMat = clothMat(0xffffff, tex, 'flag', wind), pole = poleGeo(6.2, T.trim);
    pole.userData.shared = true;
    const banners: Banner[] = [];
    for (const [x, z, w] of [[-13.4, 13.4, 2.7], [13.4, 13.4, 2.7], [-4.6, 19.6, 3.2], [4.6, 19.6, 3.2]]) {
      const g = new THREE.Group(); g.position.set(x, GROUND, s * z); this.scene.add(g);
      const p = new THREE.Mesh(pole, this.prop); g.add(p);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.62, 12, 5).translate(w / 2, 0, 0), flagMat);
      const top = 6.2 - w * 0.31 - 0.05;
      flag.position.set(0, top, 0); // every flag streams the same way, as the camp banners do in the one wind
      g.add(flag);
      banners.push({ g, flag, top, tilt: Math.sign(x) });
    }
    const torches = [[-AISLE + 0.4, 12.1], [AISLE - 0.4, 12.1], [-13.2, 17.2], [13.2, 17.2]].map(([x, z]) => new THREE.Vector3(x, GROUND, s * z));
    return { side, s, yaw, men: [], drummers, darm, drums, banners, wind, torches, shown: 0.6, target: 0.6 };
  }

  /** Rank sizes and model detail follow the tier; props cast shadows where scenery props do. */
  applyQuality(s: Settings) {
    const tier = (Object.keys(TIERS) as Tier[]).find((k) => TIERS[k] === s) ?? 'high';
    for (const h of Object.values(this.hosts)) {
      for (const d of h.drums) d.castShadow = s.propShadows;
      for (const b of h.banners) b.g.children.forEach((c) => { c.castShadow = s.propShadows; });
      h.drummers.castShadow = s.propShadows;
    }
    this.torchPoles.castShadow = s.propShadows;
    if (tier === this.tier) return;
    this.tier = tier;
    const R = RANKS[tier];
    for (const h of Object.values(this.hosts)) {
      if (h.ranks) { h.ranks.removeFromParent(); h.ranks.geometry.dispose(); h.ranks.dispose(); }
      h.men = [];
      const half = R.per / 2;
      for (let r = 0; r < R.rows; r++) for (let c = 0; c < R.per; c++) {
        const i = h.men.length, k = c < half ? -1 : 1, j = c < half ? c : c - half;
        const x = k * (AISLE + 0.5 + j * R.gap) + (r % 2) * R.gap * 0.5 * k + (hash(i, 1) - 0.5) * 0.18;
        h.men.push({ x, z: h.s * (FRONT + r * ROW + (hash(i, 2) - 0.5) * 0.16), ph: hash(i, 3) * 6.28,
          drop: r === 0 ? hash(i, 4) * 0.55 : 0.25 + 0.75 * hash(i, 4) * (0.6 + 0.4 * r / R.rows), flee: hash(i, 5), jit: hash(i, 6) });
      }
      const g = soldierGeo(h.side, R.lo), arm = new THREE.InstancedBufferAttribute(new Float32Array(h.men.length * 2), 2);
      arm.setUsage(THREE.DynamicDrawUsage); g.setAttribute('aArm', arm);
      const m = new THREE.InstancedMesh(g, this.mat, h.men.length);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.customDepthMaterial = this.depth; m.frustumCulled = false; m.receiveShadow = true;
      h.ranks = m; h.arm = arm;
      this.scene.add(m);
    }
    for (const h of Object.values(this.hosts)) h.ranks!.castShadow = !R.lo; // low: no per-instance shadows
  }

  // ---------- inputs ----------
  /** The position's verdict: morale per side, who is giving check, and the result. */
  set(morale: Record<Side, number>, check: Side | null, over: boolean, winner: Side | null) {
    for (const side of ['r', 'b'] as const) this.hosts[side].target = morale[side];
    if (over && !this.over) this.overT = clock.time + 2.4; // erupt as the general falls
    this.check = check; this.over = over; this.winner = winner;
  }
  /** Show the state as it stands, with no easing and no leftover cheer (undo, restart, scrubbing). */
  snap() {
    for (const h of Object.values(this.hosts)) h.shown = h.target;
    this.cheerEv = null; this.overT = -1e9;
  }
  /** A capture: the taker's reserves cheer and roll their drums, the other side recoils. */
  cheer(side: Side) {
    this.cheerEv = { side, t0: clock.time };
    sfx.roll(); sfx.cheer();
  }
  /** A check: the checking side's drums beat (the beat itself lasts as long as the check). */
  drums() { sfx.warDrums(); }
  morale(): Record<Side, number> { return { r: this.hosts.r.target, b: this.hosts.b.target }; }

  // ---------- per frame ----------
  update(dt: number, storm: number) {
    const t = clock.time;
    let ti = 0;
    for (const h of Object.values(this.hosts)) {
      h.shown += (h.target - h.shown) * Math.min(1, dt * 0.8);
      const m = h.shown, side = h.side, o = this.o;
      const cheer = this.cheerEv?.side === side ? env(t - this.cheerEv.t0) : 0;
      const recoil = this.cheerEv && this.cheerEv.side !== side ? env(t - this.cheerEv.t0) : 0;
      const checking = this.check === side, checked = !!this.check && !checking;
      const fin = this.over ? smooth(clamp((t - this.overT) / 1.4, 0, 1)) : 0;
      const won = fin > 0 && this.winner === side, lost = fin > 0 && !!this.winner && this.winner !== side;
      // Ranks: full at good morale, thinning from the back as it sinks.
      const keep = clamp(0.3 + 1.15 * m, 0, 1), R = h.ranks!, arm = h.arm!;
      let n = 0;
      for (const man of h.men) {
        if (man.drop > keep) continue;
        let x = man.x, z = man.z, y = GROUND, yaw = h.yaw;
        let lean = clamp((0.5 - m) * 0.4, -0.05, 0.3) + 0.012 * Math.sin(t * 1.7 + man.ph) - (checked ? 0.06 : 0);
        let sy = 0.93 + 0.12 * m + 0.012 * Math.sin(t * 1.7 + man.ph);
        let lift = 0, ang = m < 0.45 ? (0.45 - m) * 1.8 : 0;
        if (checking) { lift += 0.12 + 0.08 * Math.sin(t * 5 + man.ph); ang -= 0.08; }
        if (cheer > 0) { lift += cheer * (0.38 + 0.18 * Math.sin(t * 11 + man.ph)); ang -= cheer * 0.3; y += cheer * Math.max(0, Math.sin(t * 8 + man.ph * 3)) * 0.22; }
        if (recoil > 0) { lean -= recoil * 0.28; z += h.s * recoil * 0.3; }
        if (won) { y += fin * Math.max(0, Math.sin(t * 7 + man.ph * 2)) * 0.32; lift = fin * (0.4 + 0.22 * Math.sin(t * 9 + man.ph)); ang = -0.3 * fin; lean = -0.05; }
        if (lost) {
          if (man.flee > 0.62) { // break and run for the gate
            z = h.s * Math.min(BACK, Math.abs(z) + fin * (2.5 + man.jit * 3.5)); x += fin * (man.jit - 0.5) * 2.5; yaw += fin * Math.PI;
            ang = lerp(ang, 1.2, fin); lean = 0.25 * fin;
          } else { y -= 0.3 * fin; sy *= 1 - 0.2 * fin; lean = lerp(lean, 0.5, fin); ang = lerp(ang, 1.25, fin); } // kneel
        }
        o.position.set(x, y, z); o.rotation.set(lean, yaw, 0.02 * Math.sin(t * 0.8 + man.ph), 'YXZ'); o.scale.set(1, sy, 1);
        o.updateMatrix(); R.setMatrixAt(n, o.matrix); arm.setXY(n, lift, ang); n++;
      }
      R.count = n; R.instanceMatrix.needsUpdate = true; arm.needsUpdate = true;
      // Drums: an idle beat now and then, hammering through a check, a roll for a cheer and the victory.
      const beat = lost ? 0 : Math.max(checking ? 1 : 0.18, cheer, won ? 1 : 0), rate = checking || won ? 9 : cheer > 0 ? 16 : 4;
      h.drums.forEach((d, i) => {
        const st = Math.abs(Math.sin(t * rate * 0.5 + i * 1.3)), hit = beat * Math.pow(1 - st, 6);
        o.position.copy(d.position).addScaledVector(new THREE.Vector3(Math.sin(h.yaw), 0, Math.cos(h.yaw)), -0.9); o.position.y = GROUND - 0.3 * (lost ? fin : 0);
        o.rotation.set(lost ? 0.4 * fin : 0, h.yaw, 0, 'YXZ'); o.scale.set(1, 1 - (lost ? 0.18 * fin : 0), 1); o.updateMatrix();
        h.drummers.setMatrixAt(i, o.matrix); h.darm.setXY(i, 0, lost ? 0.9 * fin : -(0.15 + 1.1 * beat * st));
        d.scale.setScalar(1 + 0.05 * hit);
      });
      h.drummers.instanceMatrix.needsUpdate = true; h.darm.needsUpdate = true;
      // Banners: higher and livelier with morale, surging in a check or a storm, struck when the army breaks.
      h.wind.value = (0.4 + 0.9 * m) * (1 + 0.9 * storm) + (checking ? 1.3 : 0) + cheer * 0.8 + (won ? 0.9 : 0);
      for (const b of h.banners) {
        b.flag.position.y = b.top - (1 - clamp(m * 1.6, 0, 1)) * 1.4 - (lost ? 1.2 * fin : 0);
        b.g.rotation.z = (lost ? 0.75 * fin : 0) * b.tilt + 0.01 * Math.sin(t * 0.9 + b.g.position.x) * (1 + storm);
      }
      // Torches: burn with morale, gutter as it fails.
      const flame = (lost ? 0.25 : 0.3 + 0.75 * m) * (won ? 1.25 : 1);
      for (const p of h.torches) {
        const f = flame * (1 + 0.16 * Math.sin(t * 13 + ti * 1.7) + 0.1 * Math.sin(t * 29 + ti * 3.1));
        o.position.set(p.x, GROUND + 2.33, p.z); o.rotation.set(0, 0, 0); o.scale.set(f, f * (0.9 + 0.2 * Math.sin(t * 17 + ti)), f); o.updateMatrix();
        this.flames.setMatrixAt(ti++, o.matrix);
        if (Math.random() < dt * 16 * flame) fx.fire(o.position, 1, 0.5 + 0.5 * flame);
        if (Math.random() < dt * 2 * flame) fx.embers(o.position, 1, 0xff8a30, 0.1, 2);
      }
    }
    this.flames.instanceMatrix.needsUpdate = true;
  }
}

export const armies = new Armies();
