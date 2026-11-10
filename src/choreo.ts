// Per-unit choreography: every piece type has its own move, attack and death animation.
// Attack is keyed by attacker type and victim class, brace and death by the victim's type.
import * as THREE from 'three';
import type { PType } from './engine';
import { angDiff, ease, fordDepth, groundHeight, inWater, lerp, rand, randS, tween, wait, WADE, WATER_Y } from './core';
import { fx } from './fx';
import { TEAM } from './kit';
import { sfx } from './audio';
import { rig } from './camera';
import { scars } from './scars';
import { clearOfBridges, river } from './river';
import type { Unit } from './units';

export type HitKind = 'blade' | 'ram' | 'blast' | 'toss' | 'crush';
export type HitFn = (dir: THREE.Vector3, kind: HitKind) => void;

const V = () => new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const glowOf = (u: Unit) => TEAM[u.piece.side].glow;
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);
const flatDir = (a: THREE.Vector3, b: THREE.Vector3) => V().set(b.x - a.x, 0, b.z - a.z).normalize();

// ---------- primitives ----------
function turn(u: Unit, yaw: number, dur = 0.16) {
  const a = u.root.rotation.y, d = angDiff(a, yaw);
  if (Math.abs(d) < 0.01) return Promise.resolve();
  return tween(dur * (0.6 + Math.abs(d) / Math.PI), (t) => { u.root.rotation.y = a + d * t; }, ease.io2);
}
const faceTo = (u: Unit, p: THREE.Vector3, dur?: number) => turn(u, yawOf(p.x - u.root.position.x, p.z - u.root.position.z), dur);

/**
 * Wading slows a unit down: re-time a straight path so it covers the water at (1 - slow) of its speed.
 * Returns how much longer the move takes and the map from eased time to share of the distance.
 */
function wadeWarp(u: Unit, x0: number, z0: number, x1: number, z1: number) {
  const N = 40, slow = WADE[u.piece.type].slow, cost = [0];
  for (let i = 1; i <= N; i++) { const k = (i - 0.5) / N; cost.push(cost[i - 1] + 1 / (1 - slow * fordDepth(lerp(x0, x1, k), lerp(z0, z1, k)))); }
  const total = cost[N];
  if (total < N * 1.001) return null;
  return {
    stretch: total / N,
    at(tau: number) {
      const c = tau * total;
      let j = 0; while (j < N - 1 && cost[j + 1] < c) j++;
      return (j + (c - cost[j]) / (cost[j + 1] - cost[j])) / N;
    },
  };
}

/**
 * Move the unit along the ground. onStep gets eased progress and the distance covered this frame.
 * A path through open water wades it; one that grazes a bridge keeps to the old ford (no deck clipping).
 */
function travel(u: Unit, to: THREE.Vector3, dur: number, e = ease.lin, onStep?: (k: number, d: number) => void) {
  const x0 = u.root.position.x, z0 = u.root.position.z, wet = clearOfBridges(x0, z0, to.x, to.z);
  const warp = wet ? wadeWarp(u, x0, z0, to.x, to.z) : null, w = WADE[u.piece.type].weight;
  let px = x0, pz = z0;
  return tween(dur * (warp?.stretch ?? 1), (t) => {
    const k = warp ? warp.at(e(t)) : e(t), x = lerp(x0, to.x, k), z = lerp(z0, to.z, k);
    u.setXZ(x, z, wet);
    const d = Math.hypot(x - px, z - pz); px = x; pz = z;
    onStep?.(k, d);
    if (u.body.position.y < 0.3) river.wade(u.water, u.root.position, w, d);
  });
}

/** Ballistic hop through the air (ground height still tracked by the root). */
function hop(u: Unit, to: THREE.Vector3, height: number, dur: number, onStep?: (t: number) => void) {
  const x0 = u.root.position.x, z0 = u.root.position.z;
  return tween(dur, (t) => {
    u.setXZ(lerp(x0, to.x, t), lerp(z0, to.z, t), false); // airborne: the arc clears the water
    u.body.position.y = 4 * height * t * (1 - t);
    onStep?.(t);
  }).then(() => { u.body.position.y = 0; });
}

function walkPose(h: any, ph: number, amp: number, arms = true) {
  h.legL.rotation.x = Math.sin(ph) * amp; h.legR.rotation.x = -Math.sin(ph) * amp;
  if (arms) h.armL.rotation.x = -Math.sin(ph) * amp * 0.7;
  h.g.position.y = Math.abs(Math.sin(ph)) * 0.045;
}
function gallopPose(p: any, ph: number, amp: number) {
  for (let i = 0; i < 4; i++) {
    const a = ph + (i < 2 ? 0 : Math.PI * 0.9) + (i % 2) * 0.5;
    p.legs[i].rotation.x = Math.sin(a) * amp;
    p.knees[i].rotation.x = Math.max(0, Math.cos(a)) * amp * 1.3;
  }
  p.hb.position.y = 0.98 + Math.abs(Math.sin(ph)) * 0.08;
  p.hb.rotation.x = Math.sin(ph * 2) * 0.05;
  p.tail.rotation.x = 0.7 * amp;
}
function elephantPose(p: any, ph: number, amp: number) {
  const s = Math.sin(ph) * amp;
  p.legs[0].rotation.x = s; p.legs[3].rotation.x = s; p.legs[1].rotation.x = -s; p.legs[2].rotation.x = -s;
  p.eb.position.y = 1.25 + Math.abs(Math.sin(ph)) * 0.07;
  p.eb.rotation.z = Math.sin(ph) * 0.035;
  p.trunk.forEach((g: THREE.Group, i: number) => { g.rotation.x = (i === 0 ? -0.25 : i > 4 ? -0.35 : 0.02) + Math.sin(ph + i * 0.5) * 0.1; });
}
function spinWheels(p: any, d: number, r = 0.37) { for (const w of p.wheels) w.rotation.x += d / r; }

/** Fire a callback each time progress crosses one of n evenly spaced beats. */
function beats(n: number, fn: (i: number) => void) {
  let last = 0;
  return (k: number) => { const i = Math.floor(k * n + 0.0001); if (i > last) { for (let j = last + 1; j <= Math.min(i, n); j++) fn(j); last = i; } };
}

async function settle(u: Unit) {
  await turn(u, u.homeYaw, 0.2);
  u.rest(); u.body.position.set(0, 0, 0); u.body.rotation.set(0, 0, 0);
}

/** Smoothly drive a set of rotation.x values (and optional extras) towards targets. */
function pose(dur: number, items: [THREE.Object3D, number][], e = ease.out3) {
  const from = items.map(([o]) => o.rotation.x);
  return tween(dur, (t) => items.forEach(([o, v], i) => { o.rotation.x = lerp(from[i], v, t); }), e);
}

// ---------- MOVE ----------
type MoveFn = (u: Unit, to: THREE.Vector3) => Promise<void>;

async function walkTo(u: Unit, to: THREE.Vector3, dur: number, steps: number, heavy: boolean) {
  const p = u.parts, h = p.rider ?? p;
  const beat = beats(steps, () => {
    heavy ? sfx.heavyStep() : sfx.step();
    if (!inWater(u.root.position.x, u.root.position.z)) fx.dust(u.root.position, heavy ? 4 : 2, heavy ? 0.7 : 0.45);
    if (heavy) fx.embers(u.root.position, 4, glowOf(u), 0.3, 1);
  });
  await travel(u, to, dur, ease.lin, (k) => { walkPose(h, k * steps * Math.PI, heavy ? 0.5 : 0.75); beat(k); });
}

const MOVE: Record<PType, MoveFn> = {
  // General: a stately march, cape streaming.
  async K(u, to) {
    await faceTo(u, to);
    const p = u.parts;
    tween(0.3, (t) => { p.wind.value = lerp(0.16, 0.9, t); });
    await walkTo(u, to, 0.95, 4, true);
    tween(0.5, (t) => { p.wind.value = lerp(0.9, 0.16, t); });
  },
  // Guard: crouch, then a blink-fast diagonal dash trailing light.
  async A(u, to) {
    await faceTo(u, to, 0.1);
    const p = u.parts;
    await tween(0.1, (t) => { p.g.position.y = -0.1 * t; p.torso.rotation.x = 0.4 * t; });
    sfx.whoosh();
    await travel(u, to, 0.24, ease.io3, (k) => {
      p.armR.rotation.x = -0.15 - k * Math.PI * 2;
      p.legL.rotation.x = 0.9; p.legR.rotation.x = -0.7;
      fx.glow(V().copy(u.root.position).setY(u.root.position.y + rand(0.4, 1.4)), glowOf(u), 0.55, 0.35, 0.5);
    });
    fx.dust(u.root.position, 6, 0.8);
    await tween(0.14, (t) => { p.g.position.y = -0.1 * (1 - t); p.torso.rotation.x = 0.4 * (1 - t); });
  },
  // Elephant: four earth-shaking footfalls.
  async B(u, to) {
    await faceTo(u, to, 0.3);
    const p = u.parts;
    const dir = flatDir(u.root.position, to);
    const beat = beats(4, () => { sfx.stomp(0.7); rig.shake(0.2); fx.dust(u.root.position, 9, 1.3); scars.mark('foot', u.root.position, 1.5, 0.3, dir); });
    await travel(u, to, 1.15, ease.lin, (k) => { elephantPose(p, k * 4 * Math.PI, 0.42); beat(k); });
  },
  // Horse: gather and vault in a single arc (or, across the river clear of the bridges, charge through the ford).
  async N(u, to) {
    await faceTo(u, to, 0.14);
    const p = u.parts, o = u.root.position;
    if (Math.sign(o.z) !== Math.sign(to.z) && clearOfBridges(o.x, o.z, to.x, to.z)) {
      sfx.neigh();
      const beat = beats(6, () => { sfx.hoof(); if (!inWater(u.root.position.x, u.root.position.z)) fx.dust(u.root.position, 4, 0.9); });
      await travel(u, to, 0.9, ease.io2, (k) => { gallopPose(p, k * 6 * Math.PI, 0.75); p.rider.torso.rotation.x = 0.2 * Math.sin(Math.PI * k); beat(k); });
      sfx.hoof(); fx.dust(u.root.position, 8, 1);
      await tween(0.2, (t) => { p.hb.rotation.x = -0.25 * Math.sin(Math.PI * t); });
      return;
    }
    await tween(0.14, (t) => { p.hb.position.y = 0.98 - 0.1 * t; p.hb.rotation.x = 0.12 * t; });
    sfx.neigh(); sfx.whoosh();
    fx.dust(u.root.position, 6, 0.9);
    await hop(u, to, 1.5, 0.56, (t) => {
      const s = Math.sin(Math.PI * t);
      p.hb.rotation.x = lerp(-0.6, 0.38, t); p.hb.position.y = 0.98;
      p.legs[0].rotation.x = p.legs[1].rotation.x = -1.1 * s; p.knees[0].rotation.x = p.knees[1].rotation.x = 1.5 * s;
      p.legs[2].rotation.x = p.legs[3].rotation.x = 0.9 * s; p.tail.rotation.x = 0.9 * s;
      p.rider.torso.rotation.x = 0.3 * s;
    });
    sfx.hoof(); sfx.hoof(0.07); fx.dust(u.root.position, 10, 1.1); rig.shake(0.1);
    scars.mark('hoof', u.root.position, 1.05, 0.4, flatDir(V().set(u.root.position.x - Math.sin(u.root.rotation.y), 0, u.root.position.z - Math.cos(u.root.rotation.y)), u.root.position));
    await tween(0.16, (t) => { p.hb.rotation.x = 0.38 * (1 - t); p.hb.position.y = 0.98 - 0.08 * Math.sin(Math.PI * t); });
  },
  // Chariot: lurch, thunder down the file, skid to a halt.
  async R(u, to) {
    await faceTo(u, to, 0.22);
    const p = u.parts, d = u.root.position.distanceTo(to), dur = 0.34 + 0.085 * d, rut = rutter(u, 1.5, 0.3);
    sfx.rumble(dur + 0.1);
    await travel(u, to, dur, ease.io2, (k, dd) => {
      spinWheels(p, dd); rut(dd);
      p.cb.rotation.x = Math.sin(Math.PI * 2 * k) * 0.07;
      p.cb.position.y = 0.5 + Math.sin(k * 60) * 0.012;
      if (dd > 0.02) fx.dust(u.root.position, 1, 0.9);
    });
    fx.dust(u.root.position, 12, 1.3);
  },
  // Cannon: the gunner trundles it along.
  async C(u, to) {
    await faceTo(u, to, 0.25);
    const p = u.parts, d = u.root.position.distanceTo(to), dur = 0.4 + 0.17 * d;
    sfx.creak(dur);
    const steps = Math.max(2, Math.round(d * 1.2)), rut = rutter(u, 1.25, 0.2);
    await travel(u, to, dur, ease.io2, (k, dd) => {
      spinWheels(p, dd, 0.39); rut(dd);
      walkPose(p.rider, k * steps * Math.PI, 0.6, true); p.rider.g.position.y = 0;
      p.barrel.rotation.x = -0.08 + Math.sin(k * 40) * 0.015;
      if (Math.random() < 0.3 && dd > 0.01) fx.dust(u.root.position, 1, 0.5);
    });
  },
  // Soldier: a brisk jog (wading through the ford when crossing the river).
  async P(u, to) {
    await faceTo(u, to, 0.12);
    await walkTo(u, to, 0.5 * Math.max(1, u.root.position.distanceTo(to) / 2.2), 3, false);
  },
};

export async function playMove(u: Unit, to: THREE.Vector3) {
  u.busy = true;
  await MOVE[u.piece.type](u, to);
  u.setXZ(to.x, to.z);
  await settle(u);
  sfx.place();
  u.busy = false;
}

// ---------- ATTACK ----------
// Every attacker has three techniques, chosen by what it is fighting: foot soldiers, beasts or
// war machines. Together with the victim's own brace and death that makes each pairing distinct.
export type Klass = 'foot' | 'beast' | 'machine';
export const klassOf = (t: PType): Klass => (t === 'N' || t === 'B' ? 'beast' : t === 'R' || t === 'C' ? 'machine' : 'foot');

/** Title shown for each legal attacker/victim pairing (K, A and B never meet A or B). */
export const DUEL: Record<string, string> = {
  KP: '帥旗所指', KN: '落馬成擒', KR: '劍劈戰車', KC: '斷其火器',
  AP: '近衛誅卒', AN: '戟挑戰馬', AR: '飛戟破車', AC: '夜襲炮營',
  BP: '象踏卒伍', BN: '巨象摧騎', BR: '踏碎戰車', BC: '踏平炮壘',
  NP: '鐵騎掠陣', NA: '馬踏宮門', NB: '躍馬斬象', NN: '雙騎交鋒', NR: '馬踏連車', NC: '馬踏炮陣',
  RP: '戰車輾卒', RA: '衝車破士', RB: '車撞巨象', RN: '車馬爭雄', RR: '雙車對撞', RC: '輾碎炮架',
  CP: '霰彈洗地', CA: '炮轟宮闕', CB: '一炮伏象', CN: '轟落戰馬', CR: '連炮碎車', CC: '隔山打炮',
  PP: '短兵相接', PA: '卒破士角', PB: '以卒搏象', PN: '拒馬長槍', PR: '飛槍掀車', PC: '奪炮斷火',
};

type AttackFn = (u: Unit, to: THREE.Vector3, dir: THREE.Vector3, hit: HitFn) => Promise<void>;
const before = (to: THREE.Vector3, dir: THREE.Vector3, gap: number) => V().copy(to).addScaledVector(dir, -gap);
const mid = (a: THREE.Vector3, b: THREE.Vector3, k = 0.5) => V().lerpVectors(a, b, k);
const trail = (u: Unit) => fx.glow(V().copy(u.root.position).setY(u.root.position.y + u.body.position.y + rand(0.4, 1.4)), glowOf(u), 0.55, 0.35, 0.5);

async function thrust(u: Unit, h: any, w: THREE.Object3D, dir: THREE.Vector3, hit: HitFn) {
  await pose(0.16, [[h.armR, 0.5], [w, 1.1], [h.torso, -0.2]]);
  sfx.slash();
  const z0 = h.g.position.z;
  await tween(0.07, (t) => { h.armR.rotation.x = lerp(0.5, -1.2, t); w.rotation.x = lerp(1.1, Math.PI / 2 + 1.2, t); h.torso.rotation.x = lerp(-0.2, 0.42, t); h.g.position.z = z0 + 0.3 * t; });
  const tip = V().copy(u.root.position).addScaledVector(dir, 1.1).setY(u.root.position.y + 1.0);
  fx.slash(tip, dir, glowOf(u), { vertical: true, size: 0.7, travel: 1.4, dur: 0.25 });
  hit(dir, 'blade');
  await wait(0.3);
  await tween(0.2, (t) => { h.g.position.z = z0 + 0.3 * (1 - t); h.torso.rotation.x = 0.42 * (1 - t); });
}

/** General's finisher: gather light on the raised blade, then loose a flying crescent. */
async function cleave(u: Unit, dir: THREE.Vector3, hit: HitFn, charge: number) {
  const p = u.parts, tipPos = V();
  sfx.charge();
  await tween(charge, (t) => {
    p.armR.rotation.x = lerp(0.1, -2.9, t); p.weapon.rotation.x = lerp(2.2, 1.5, t); p.torso.rotation.x = -0.18 * t; p.wind.value = 0.8 + t;
    fx.gather(tipPos.copy(u.root.position).setY(u.root.position.y + 2.7), 2, glowOf(u), 1.2);
  }, ease.out2);
  fx.flash(u.root.position, glowOf(u), 40, 0.4);
  sfx.slash(); sfx.clang();
  await tween(0.09, (t) => { p.armR.rotation.x = lerp(-2.9, -0.45, t); p.weapon.rotation.x = lerp(1.5, 1.95, t); p.torso.rotation.x = lerp(-0.18, 0.35, t); });
  const o = V().copy(u.root.position).setY(u.root.position.y + 1.1);
  fx.slash(o, dir, glowOf(u), { size: 2.0, travel: 3.2, tilt: 0.5, dur: 0.45 });
  fx.slash(o, dir, 0xffffff, { size: 1.5, travel: 2.8, tilt: 0.5, dur: 0.35 });
  scars.mark('gash', mid(u.root.position, o.addScaledVector(dir, 2.6)), 2.4, 0.6, dir, 0.3);
  hit(dir, 'blade');
}

// ----- cannon pieces -----
async function aim(u: Unit, elev: number, fuse = 0.4) {
  const p = u.parts;
  await Promise.all([pose(0.3, [[p.barrel, elev]], ease.io2), pose(0.3, [[p.rider.armR, -1.35], [p.weapon, 1.0]])]);
  sfx.fuse();
  const breech = V(), back = V().set(-Math.sin(u.root.rotation.y), 0, -Math.cos(u.root.rotation.y));
  await tween(fuse, () => { p.barrel.getWorldPosition(breech); fx.sparks(breech.addScaledVector(back, 0.3).setY(breech.y + 0.2), UP, 2, 0xffe080, 2.5); });
}
function muzzleBlast(u: Unit, dir: THREE.Vector3, power = 1) {
  const p = u.parts, mp = p.muzzle.getWorldPosition(V());
  sfx.boom(power); rig.shake(0.5 * power);
  fx.flash(mp, 0xffb060, 110 * power, 0.4);
  fx.sparks(mp, dir, 40 * power, 0xffa040, 12);
  for (let i = 0; i < 16 * power; i++) fx.fire(V().copy(mp).addScaledVector(dir, rand(0.9)), 1, 1.3);
  fx.smoke(mp, 10 * power, 1.1);
  tween(0.55, (t) => { p.cb.position.z = -0.4 * power * Math.sin(Math.PI * Math.pow(t, 0.45)); }).then(() => { p.cb.position.z = 0; });
  spinWheels(p, -0.3);
  return mp;
}
async function shell(from: THREE.Vector3, tgt: THREE.Vector3, H: number, dur: number, size = 0.15) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe0a0 }));
  fx.scene.add(s);
  await tween(dur, (t) => {
    s.position.lerpVectors(from, tgt, t); s.position.y += 4 * H * t * (1 - t);
    fx.fire(s.position, size > 0.12 ? 2 : 1, size * 5.3); fx.glow(s.position, 0xffc060, size * 7, 0.12, 0.6);
    if (Math.random() < 0.6) fx.smoke(s.position, 1, 0.4);
  });
  s.removeFromParent(); s.geometry.dispose();
}
/** After the shot the whole gun vaults over its screen onto the target square. */
async function vault(u: Unit, to: THREE.Vector3) {
  const p = u.parts;
  await Promise.all([wait(0.7), pose(0.5, [[p.barrel, -0.08], [p.rider.armR, -0.5], [p.weapon, 0.3]], ease.io2)]);
  sfx.boom(0.5); sfx.whoosh();
  fx.dust(u.root.position, 14, 1.4); fx.fire(u.root.position, 10, 1.2);
  scars.mark('scorch', u.root.position, 1.6, 0.35);
  await hop(u, to, 2.5, 0.72, (t) => {
    p.cb.rotation.x = -Math.sin(Math.PI * 2 * t) * 0.22; spinWheels(p, 0.2);
    const q = V().copy(u.root.position); q.y += u.body.position.y + 0.3;
    fx.fire(q, 1, 0.7); if (Math.random() < 0.5) fx.smoke(q, 1, 0.5);
  });
  sfx.stomp(1); rig.shake(0.4);
  fx.dust(u.root.position, 18, 1.5); fx.shockwave(u.root.position, 0xffb060, 2.4, 0.5);
}

// ----- chariot pieces -----
async function rev(u: Unit, dir: THREE.Vector3, dur: number, burn = false) {
  const p = u.parts;
  await tween(dur, (t) => {
    spinWheels(p, 0.25 * t); p.cb.rotation.x = 0.09 * t; p.cb.position.y = 0.5 + Math.sin(t * 50) * 0.015;
    const q = V().copy(u.root.position).addScaledVector(dir, -0.7);
    fx.dust(q, 1, 1);
    if (burn) { fx.fire(q.setY(0.2), 1, 0.8, glowOf(u), 0xff4000); fx.sparks(q, V().copy(dir).negate(), 2, glowOf(u), 5); }
  });
}
const wake = (u: Unit, dir: THREE.Vector3) => {
  fx.dust(V().copy(u.root.position).addScaledVector(dir, -0.6), 2, 1.1);
  fx.add.emit({ x: u.root.position.x + randS(0.5), y: 0.25, z: u.root.position.z + randS(0.5), life: 0.3, size: 0.1, size2: 0, c: glowOf(u) });
};

const ATTACK: Record<PType, Record<Klass, AttackFn>> = {
  K: {
    // vs foot: raises the blade, gathers light, and cleaves with a flying crescent.
    async foot(u, to, dir, hit) {
      const p = u.parts;
      p.wind.value = 0.8;
      await walkTo(u, before(to, dir, 1.3), 0.5, 2, true);
      await cleave(u, dir, hit, 0.45);
      await wait(0.5);
      u.rest(); p.wind.value = 0.8;
      await walkTo(u, to, 0.5, 2, true);
      tween(0.5, (t) => { p.wind.value = lerp(0.8, 0.16, t); });
    },
    // vs beast: leaps and brings the sword down, splitting the ground towards the target.
    async beast(u, to, dir, hit) {
      const p = u.parts, tipPos = V();
      p.wind.value = 1.3;
      await tween(0.2, (t) => { p.g.position.y = -0.18 * t; p.legL.rotation.x = p.legR.rotation.x = 0.5 * t; p.armR.rotation.x = lerp(0.1, -1.5, t); });
      sfx.whoosh(); sfx.charge();
      fx.dust(u.root.position, 8, 1);
      await hop(u, before(to, dir, 1.45), 1.9, 0.62, (t) => {
        const s = Math.sin(Math.PI * t), a = Math.min(1, t / 0.8), b = Math.max(0, (t - 0.8) / 0.2);
        p.g.position.y = -0.18 * (1 - t); p.legL.rotation.x = 0.5 * (1 - t) - 0.9 * s; p.legR.rotation.x = 0.5 * (1 - t) + 0.7 * s;
        p.armR.rotation.x = b > 0 ? lerp(-3.0, -0.4, b) : lerp(-1.5, -3.0, a);
        p.weapon.rotation.x = b > 0 ? lerp(1.5, 1.95, b) : lerp(2.2, 1.5, a);
        p.torso.rotation.x = b > 0 ? lerp(-0.2, 0.45, b) : -0.2 * a;
        if (b === 0) fx.gather(tipPos.copy(u.root.position).setY(u.root.position.y + u.body.position.y + 2.7), 2, glowOf(u), 1.1);
      });
      sfx.slash(); sfx.clang(); sfx.stomp(1); rig.shake(0.6);
      const o = V().copy(u.root.position);
      fx.slash(V().copy(o).setY(o.y + 1.5), V().copy(dir).setY(-0.35).normalize(), glowOf(u), { vertical: true, size: 2.3, travel: 2.0, dur: 0.32 });
      fx.shockwave(o, glowOf(u), 3, 0.5); fx.dust(o, 14, 1.3); fx.flash(o, glowOf(u), 60, 0.4);
      // The fissure races ahead of the blade.
      scars.mark('gash', mid(o, to, 0.55), 2.9, 0.7, dir, 0.3); scars.mark('crack', o, 1.8, 0.5);
      for (let i = 0; i < 9; i++) { const q = mid(o, to, 0.15 + i * 0.1); fx.fire(q.setY(0.05), 2, 1.0, 0xffffff, glowOf(u)); fx.embers(q, 3, glowOf(u), 0.2, 2.2); }
      hit(dir, 'blade');
      await wait(0.55);
      u.rest(); p.wind.value = 0.8;
      await walkTo(u, to, 0.45, 2, true);
      tween(0.5, (t) => { p.wind.value = lerp(0.8, 0.16, t); });
    },
    // vs machine: two probing cuts ring off the armour, then the charged third goes through.
    async machine(u, to, dir, hit) {
      const p = u.parts;
      p.wind.value = 0.9;
      await walkTo(u, before(to, dir, 1.35), 0.5, 2, true);
      for (const tilt of [0.7, -0.7]) {
        await tween(0.11, (t) => { p.armR.rotation.x = lerp(0.1, -2.3, t); p.torso.rotation.y = -tilt * 0.5 * t; }, ease.out2);
        sfx.slash();
        await tween(0.06, (t) => { p.armR.rotation.x = lerp(-2.3, -0.3, t); p.torso.rotation.y = lerp(-tilt * 0.5, tilt * 0.5, t); });
        fx.slash(V().copy(u.root.position).setY(u.root.position.y + 1.1), dir, glowOf(u), { size: 1.4, travel: 1.5, tilt, dur: 0.22 });
        sfx.clang(); rig.shake(0.18);
        fx.sparks(V().copy(to).setY(to.y + 0.8), V().copy(dir).negate(), 22, 0xfff0c0, 8);
        await wait(0.1);
      }
      p.torso.rotation.y = 0;
      await cleave(u, dir, hit, 0.3);
      await wait(0.5);
      u.rest(); p.wind.value = 0.8;
      await walkTo(u, to, 0.5, 2, true);
      tween(0.5, (t) => { p.wind.value = lerp(0.8, 0.16, t); });
    },
  },
  A: {
    // vs foot: flash-step and a piercing halberd lunge.
    async foot(u, to, dir, hit) {
      const p = u.parts;
      sfx.whoosh();
      await travel(u, before(to, dir, 1.35), 0.16, ease.out3, () => trail(u));
      await thrust(u, p, p.weapon, dir, hit);
      u.rest();
      await walkTo(u, to, 0.26, 2, false);
    },
    // vs beast: slides in under its guard and rips the halberd upward.
    async beast(u, to, dir, hit) {
      const p = u.parts;
      sfx.whoosh();
      await travel(u, before(to, dir, 1.2), 0.22, ease.out3, (k) => {
        p.g.position.y = -0.3 * k; p.torso.rotation.x = 0.6 * k; p.legL.rotation.x = -1.1 * k; p.legR.rotation.x = 0.9 * k;
        p.armR.rotation.x = lerp(-0.15, 0.9, k); p.weapon.rotation.x = lerp(0.15, 1.9, k);
        trail(u); if (Math.random() < 0.5) fx.dust(u.root.position, 1, 0.7);
      });
      sfx.slash();
      await tween(0.09, (t) => {
        p.g.position.y = lerp(-0.3, 0.22, t); p.torso.rotation.x = lerp(0.6, -0.35, t); p.armR.rotation.x = lerp(0.9, -2.6, t); p.weapon.rotation.x = lerp(1.9, 0.6, t);
        p.legL.rotation.x = -1.1 * (1 - t); p.legR.rotation.x = 0.9 * (1 - t);
      });
      fx.slash(V().copy(u.root.position).setY(u.root.position.y + 0.4), V().copy(dir).setY(0.9).normalize(), glowOf(u), { vertical: true, size: 1.9, travel: 2.2, dur: 0.3 });
      hit(dir, 'blade');
      await wait(0.35);
      await tween(0.15, (t) => { p.g.position.y = 0.22 * (1 - t); });
      u.rest();
      await walkTo(u, to, 0.26, 2, false);
    },
    // vs machine: whirls into the air and drives the halberd down through the deck.
    async machine(u, to, dir, hit) {
      const p = u.parts;
      await tween(0.12, (t) => { p.g.position.y = -0.16 * t; p.torso.rotation.x = 0.35 * t; });
      sfx.whoosh();
      await hop(u, before(to, dir, 0.95), 2.3, 0.56, (t) => {
        u.body.rotation.y = t * Math.PI * 2; p.g.position.y = -0.16 * (1 - t); p.torso.rotation.x = 0.35 * (1 - t);
        p.armR.rotation.x = lerp(-0.15, -2.9, Math.min(1, t * 1.6)); p.weapon.rotation.x = lerp(0.15, 2.7, Math.min(1, t * 1.6));
        p.legL.rotation.x = -0.7 * Math.sin(Math.PI * t); p.legR.rotation.x = 0.5 * Math.sin(Math.PI * t);
        trail(u);
      });
      u.body.rotation.y = 0;
      sfx.clang(); sfx.stomp(0.8); rig.shake(0.5);
      await tween(0.06, (t) => { p.armR.rotation.x = lerp(-2.9, -0.7, t); p.torso.rotation.x = 0.5 * t; p.g.position.y = -0.2 * t; });
      fx.slash(V().copy(u.root.position).setY(u.root.position.y + 2.2), V().copy(dir).setY(-1.6).normalize(), glowOf(u), { vertical: true, size: 1.7, travel: 1.7, dur: 0.26 });
      fx.shockwave(to, glowOf(u), 3, 0.5); fx.sparks(V().copy(to).setY(to.y + 0.7), UP, 40, 0xfff0c0, 9);
      scars.mark('crack', to, 2.2, 0.55);
      hit(dir, 'crush');
      await wait(0.45);
      u.rest();
      await walkTo(u, to, 0.24, 2, false);
    },
  },
  B: {
    // vs foot: charges, tosses the foe with its tusks, then stomps the ground flat.
    async foot(u, to, dir, hit) {
      const p = u.parts;
      await elephantCharge(u, before(to, dir, 1.75), 0.45);
      await tween(0.1, (t) => { p.head.rotation.x = lerp(0.45, -0.65, t); p.trunk.forEach((g: THREE.Group) => { g.rotation.x = lerp(g.rotation.x, -0.55, t); }); p.eb.rotation.x = -0.12 * t; });
      fx.sparks(V().copy(to).setY(to.y + 0.9), UP, 26, 0xfff0c0, 8);
      hit(dir, 'toss');
      await wait(0.4);
      await tween(0.25, (t) => { p.head.rotation.x = -0.65 * (1 - t); p.eb.rotation.x = -0.12 * (1 - t); });
      await hop(u, to, 0.45, 0.42, (t) => elephantPose(p, t * 2 * Math.PI, 0.5));
      elephantStomp(u, 1);
    },
    // vs beast: lowers its head and swings the tusks sideways like a hammer.
    async beast(u, to, dir, hit) {
      const p = u.parts;
      await elephantCharge(u, before(to, dir, 1.9), 0.3);
      await tween(0.16, (t) => { p.head.rotation.y = -0.75 * t; p.eb.rotation.y = -0.22 * t; p.head.rotation.x = lerp(0.3, 0.1, t); }, ease.out2);
      sfx.whoosh();
      await tween(0.08, (t) => { p.head.rotation.y = lerp(-0.75, 0.8, t); p.eb.rotation.y = lerp(-0.22, 0.25, t); });
      const side = V().set(dir.z, 0, -dir.x);
      fx.slash(V().copy(u.root.position).addScaledVector(dir, 1.0).setY(1.0), V().copy(dir).addScaledVector(side, -0.5).normalize(), 0xfff0d0, { size: 1.6, travel: 1.4, dur: 0.25 });
      fx.sparks(V().copy(to).setY(to.y + 1.0), dir, 36, 0xfff0c0, 10); sfx.crash(); rig.shake(0.5);
      hit(V().copy(dir).addScaledVector(side, -0.45).normalize(), 'ram');
      await wait(0.45);
      await tween(0.25, (t) => { p.head.rotation.y = 0.8 * (1 - t); p.eb.rotation.y = 0.25 * (1 - t); p.head.rotation.x = 0.1 * (1 - t); });
      const beat = beats(2, () => { sfx.stomp(0.7); rig.shake(0.2); fx.dust(u.root.position, 8, 1.2); });
      await travel(u, to, 0.5, ease.lin, (k) => { elephantPose(p, k * 2 * Math.PI, 0.45); beat(k); });
      elephantStomp(u, 0.7);
    },
    // vs machine: rears up on its hind legs and comes down on top of it.
    async machine(u, to, dir, hit) {
      const p = u.parts;
      await elephantCharge(u, before(to, dir, 2.15), 0.2);
      sfx.trumpet();
      await tween(0.36, (t) => {
        p.eb.rotation.x = -0.78 * t; p.eb.position.y = 1.25 + 0.42 * t; p.head.rotation.x = lerp(0.2, -0.4, t);
        p.legs[0].rotation.x = p.legs[1].rotation.x = -1.0 * t; p.legs[2].rotation.x = p.legs[3].rotation.x = 0.7 * t;
        p.trunk.forEach((g: THREE.Group) => { g.rotation.x = lerp(g.rotation.x, -0.6, t); });
      }, ease.out3);
      await wait(0.1);
      await travel(u, to, 0.2, ease.in2, (k) => {
        p.eb.rotation.x = lerp(-0.78, 0.14, k); p.eb.position.y = 1.25 + 0.42 * (1 - k); p.head.rotation.x = lerp(-0.4, 0.3, k);
        p.legs[0].rotation.x = p.legs[1].rotation.x = -1.0 * (1 - k); p.legs[2].rotation.x = p.legs[3].rotation.x = 0.7 * (1 - k);
      });
      hit(dir, 'crush');
      elephantStomp(u, 1.3);
      await wait(0.5);
      await tween(0.3, (t) => { p.eb.rotation.x = 0.14 * (1 - t); p.head.rotation.x = 0.3 * (1 - t); });
    },
  },
  N: {
    // vs foot: never slows down - a low sweep of the glaive in passing.
    async foot(u, to, dir, hit) {
      const p = u.parts, r = p.rider, side = V().set(dir.z, 0, -dir.x);
      // Bow the gallop towards the (always empty) leg square so it clears the diagonal neighbour.
      const x0 = u.root.position.x, z0 = u.root.position.z;
      const wet = clearOfBridges(x0, z0, to.x, to.z, 1.9);
      const bow = 0.5 * Math.sign(Math.abs(to.x - x0) > Math.abs(to.z - z0) ? (to.x - x0) * side.x : (to.z - z0) * side.z);
      sfx.neigh();
      let struck = false;
      const beat = beats(4, (i) => { sfx.hoof(); fx.dust(u.root.position, 4, 0.9); if (i % 2) scars.mark('hoof', u.root.position, 1.0, 0.36, dir); });
      await travel(u, to, 0.62, (t) => t * t * (3 - 2 * t), (k) => {
        gallopPose(p, k * 4 * Math.PI, 0.75); beat(k);
        const off = bow * Math.sin(Math.PI * k);
        u.setXZ(lerp(x0, to.x, k) + side.x * off, lerp(z0, to.z, k) + side.z * off, wet);
        const a = Math.min(1, Math.max(0, (k - 0.4) / 0.3)); // only reach out once past the neighbour
        r.armR.rotation.x = lerp(-0.2, -1.2, a); r.armR.rotation.z = lerp(-0.25, -1.25, a); p.weapon.rotation.x = lerp(0.2, 1.75, a); r.torso.rotation.x = 0.35 * a;
        if (!struck && u.root.position.distanceTo(to) < 1.75) {
          struck = true; sfx.slash();
          fx.slash(V().copy(u.root.position).addScaledVector(dir, 0.5).setY(u.root.position.y + 0.9), dir, glowOf(u), { size: 1.9, travel: 2.4, tilt: 0.15, dur: 0.3 });
          hit(V().copy(dir).addScaledVector(side, 0.9).normalize(), 'toss');
        }
      });
      sfx.neigh(0.8);
      await tween(0.22, (t) => { p.hb.rotation.x = -0.55 * t; p.legs[0].rotation.x = -1.1 * t; p.legs[1].rotation.x = -0.8 * t; r.armR.rotation.x = lerp(-1.2, -2.7, t); r.armR.rotation.z = lerp(-1.25, -0.3, t); }, ease.out2);
      await wait(0.15);
      await tween(0.2, (t) => { p.hb.rotation.x = -0.55 * (1 - t); p.legs[0].rotation.x = -1.1 * (1 - t); p.legs[1].rotation.x = -0.8 * (1 - t); });
      sfx.hoof();
    },
    // vs beast: vaults high and brings the glaive down on landing.
    async beast(u, to, dir, hit) {
      const p = u.parts, r = p.rider;
      await tween(0.14, (t) => { p.hb.position.y = 0.98 - 0.1 * t; p.hb.rotation.x = 0.12 * t; });
      sfx.neigh(); sfx.whoosh();
      fx.dust(u.root.position, 8, 1);
      let struck = false;
      await hop(u, before(to, dir, 1.25), 2.1, 0.7, (t) => {
        const s = Math.sin(Math.PI * t);
        p.hb.rotation.x = lerp(-0.7, 0.45, t);
        p.legs[0].rotation.x = p.legs[1].rotation.x = -1.1 * s; p.knees[0].rotation.x = p.knees[1].rotation.x = 1.5 * s;
        p.legs[2].rotation.x = p.legs[3].rotation.x = 0.9 * s;
        const sw = t < 0.78 ? ease.out2(t / 0.78) : 1 - (t - 0.78) / 0.22;
        r.armR.rotation.x = lerp(-0.2, -2.9, sw); p.weapon.rotation.x = lerp(0.2, 1.4, Math.min(1, t / 0.78)) + (t > 0.78 ? (1 - sw) * 0.5 : 0);
        r.torso.rotation.x = t > 0.78 ? 0.4 * (1 - sw) : -0.15 * s;
        if (t > 0.86 && !struck) {
          struck = true; sfx.slash();
          fx.slash(V().copy(u.root.position).setY(u.root.position.y + u.body.position.y + 1.6).addScaledVector(dir, 0.5), V().copy(dir).setY(-0.5).normalize(), glowOf(u), { vertical: true, size: 1.9, travel: 1.6, dur: 0.3 });
        }
      });
      sfx.hoof(); sfx.hoof(0.06); sfx.clang();
      fx.dust(u.root.position, 12, 1.2); scars.mark('hoof', u.root.position, 1.1, 0.45, dir);
      hit(dir, 'blade');
      await tween(0.2, (t) => { p.hb.rotation.x = 0.45 * (1 - t); });
      await wait(0.2);
      u.rest();
      await travel(u, to, 0.3, ease.io2, (k) => gallopPose(p, k * 2 * Math.PI, 0.5));
      sfx.hoof();
    },
    // vs machine: clears the whole distance in one leap and lands on top of it.
    async machine(u, to, dir, hit) {
      const p = u.parts, r = p.rider;
      await tween(0.16, (t) => { p.hb.position.y = 0.98 - 0.12 * t; p.hb.rotation.x = 0.14 * t; });
      sfx.neigh(); sfx.whoosh();
      fx.dust(u.root.position, 10, 1.1);
      let struck = false;
      await hop(u, to, 2.9, 0.82, (t) => {
        const s = Math.sin(Math.PI * t);
        p.hb.rotation.x = lerp(-0.75, 0.55, t); p.hb.position.y = 0.98;
        p.legs[0].rotation.x = p.legs[1].rotation.x = lerp(-1.2 * s, -0.5, Math.max(0, t - 0.7) / 0.3); p.knees[0].rotation.x = p.knees[1].rotation.x = 1.5 * s * (1 - t);
        p.legs[2].rotation.x = p.legs[3].rotation.x = 0.9 * s; p.tail.rotation.x = 0.9 * s;
        r.armR.rotation.x = lerp(-0.2, -2.6, s); r.torso.rotation.x = -0.2 * s;
        trail(u);
        if (t > 0.9 && !struck) { struck = true; hit(dir, 'crush'); }
      });
      sfx.hoof(); sfx.hoof(0.05); sfx.stomp(1.1); rig.shake(0.7);
      fx.dust(u.root.position, 22, 1.6); fx.shockwave(u.root.position, glowOf(u), 3.2, 0.6);
      scars.mark('crack', to, 2.6, 0.55); scars.mark('hoof', to, 1.2, 0.5, dir);
      await tween(0.14, (t) => { p.hb.rotation.x = lerp(0.55, 0, t); p.legs[0].rotation.x = p.legs[1].rotation.x = -0.5 * (1 - t); });
      sfx.neigh(0.8);
      await tween(0.24, (t) => { p.hb.rotation.x = -0.6 * t; p.legs[0].rotation.x = -1.2 * t; p.legs[1].rotation.x = -0.9 * t; }, ease.out2);
      await wait(0.2);
      await tween(0.2, (t) => { p.hb.rotation.x = -0.6 * (1 - t); p.legs[0].rotation.x = -1.2 * (1 - t); p.legs[1].rotation.x = -0.9 * (1 - t); });
    },
  },
  R: {
    // vs foot: revs its wheels and rams straight through.
    async foot(u, to, dir, hit) {
      const p = u.parts, d = u.root.position.distanceTo(to), rut = rutter(u, 1.5, 0.34);
      sfx.rumble(0.35 + 0.3 + 0.06 * d);
      await rev(u, dir, 0.32);
      let struck = false;
      await travel(u, to, 0.26 + 0.055 * d, (t) => Math.pow(t, 1.7), (_k, dd) => {
        spinWheels(p, dd); p.cb.rotation.x = 0.05; wake(u, dir); rut(dd);
        if (!struck && u.root.position.distanceTo(to) < 1.9) {
          struck = true; sfx.crash();
          fx.sparks(V().copy(to).setY(to.y + 0.6), dir, 50, 0xffd080, 11);
          fx.flash(to, 0xffc070, 50, 0.35);
          hit(dir, 'ram');
        }
      });
      fx.dust(u.root.position, 18, 1.6);
      await tween(0.35, (t) => { p.cb.rotation.x = lerp(-0.14, 0, t); }, ease.outBack);
    },
    // vs beast: rears its nose at full tilt and hammers the bronze ram down.
    async beast(u, to, dir, hit) {
      const p = u.parts, d = u.root.position.distanceTo(to), rut = rutter(u, 1.5, 0.34);
      sfx.rumble(0.8 + 0.05 * d);
      await rev(u, dir, 0.32);
      await travel(u, before(to, dir, 2.15), 0.22 + 0.05 * d, (t) => Math.pow(t, 1.7), (k, dd) => {
        spinWheels(p, dd); p.cb.rotation.x = -0.5 * k * k; p.cb.position.y = 0.5 + 0.36 * k * k; wake(u, dir); rut(dd);
      });
      sfx.crash(); sfx.clang();
      await tween(0.08, (t) => { p.cb.rotation.x = lerp(-0.5, 0.17, t); p.cb.position.y = lerp(0.86, 0.5, t); });
      const tip = V().copy(to).addScaledVector(dir, -0.4).setY(0.9);
      fx.sparks(tip, dir, 60, 0xffd080, 12); fx.flash(to, 0xffc070, 70, 0.4); fx.shockwave(to, glowOf(u), 2.6, 0.45);
      fx.dust(u.root.position, 14, 1.4); rig.shake(0.6);
      hit(dir, 'ram');
      await wait(0.5);
      await tween(0.2, (t) => { p.cb.rotation.x = 0.17 * (1 - t); });
      await travel(u, to, 0.42, ease.io2, (_k, dd) => { spinWheels(p, dd); rut(dd); });
      fx.dust(u.root.position, 10, 1.2);
    },
    // vs machine: wheels ablaze, a head-on collision that throws it back off the wreck.
    async machine(u, to, dir, hit) {
      const p = u.parts, d = u.root.position.distanceTo(to), rut = rutter(u, 1.5, 0.4);
      sfx.rumble(1.0 + 0.05 * d);
      await rev(u, dir, 0.5, true);
      await travel(u, before(to, dir, 1.55), 0.2 + 0.045 * d, (t) => Math.pow(t, 2.3), (_k, dd) => {
        spinWheels(p, dd); p.cb.rotation.x = 0.07; wake(u, dir); rut(dd);
        fx.fire(V().copy(u.root.position).addScaledVector(dir, -0.6).setY(0.25), 1, 0.9, glowOf(u), 0xff4000);
      });
      sfx.crash(); sfx.explode(); rig.shake(1);
      const c = V().copy(to).setY(to.y + 0.7);
      fx.sparks(c, null, 90, 0xffd080, 13); fx.flash(to, 0xffe0a0, 130, 0.5);
      fx.shockwave(to, 0xffffff, 4.2, 0.5); fx.shockwave(to, glowOf(u), 2.6, 0.7, 0.09);
      scars.mark('scorch', to, 2.4, 0.5);
      hit(dir, 'ram');
      await travel(u, before(to, dir, 2.5), 0.28, ease.out2, (k, dd) => { spinWheels(p, -dd); p.cb.rotation.x = lerp(-0.26, -0.05, k); });
      await wait(0.3);
      await travel(u, to, 0.5, ease.io2, (k, dd) => { spinWheels(p, dd); p.cb.rotation.x = -0.05 * (1 - k); rut(dd); });
      fx.dust(u.root.position, 12, 1.3);
    },
  },
  C: {
    // vs foot: a spreading load of grapeshot that walks across the square.
    async foot(u, to, dir, hit) {
      const d = u.root.position.distanceTo(to);
      await aim(u, -(0.42 + d * 0.022));
      const mp = muzzleBlast(u, dir, 1.1);
      let first = true;
      await Promise.all(Array.from({ length: 6 }, async (_, i) => {
        const tgt = V().copy(to).setY(to.y + 0.3); if (i) { tgt.x += randS(0.85); tgt.z += randS(0.85); }
        await wait(i * 0.035);
        await shell(mp, tgt, 2.0 + d * 0.2 + rand(0.5), 0.5 + d * 0.035 + i * 0.02, 0.08);
        fx.explosion(tgt, 0.36); scars.mark('scorch', tgt, 1.3, 0.5);
        if (first) { first = false; sfx.explode(); rig.shake(0.8); hit(dir, 'blast'); } else { sfx.boom(0.35); rig.shake(0.15); }
      }));
      await vault(u, to);
    },
    // vs beast: lights the fuse and lobs one great fireball over the screen.
    async beast(u, to, dir, hit) {
      const d = u.root.position.distanceTo(to);
      await aim(u, -(0.38 + d * 0.022));
      const mp = muzzleBlast(u, dir);
      await shell(mp, V().copy(to).setY(to.y + 0.7), 2.3 + d * 0.2, 0.5 + d * 0.035);
      sfx.explode(); rig.shake(1);
      fx.explosion(V().copy(to), 1); scars.blast(to, 1);
      hit(dir, 'blast');
      await vault(u, to);
    },
    // vs machine: a ranging shot to crack the armour, then a double charge to finish it.
    async machine(u, to, dir, hit) {
      const p = u.parts, d = u.root.position.distanceTo(to), tgt = V().copy(to).setY(to.y + 0.7);
      await aim(u, -(0.38 + d * 0.022), 0.3);
      let mp = muzzleBlast(u, dir, 0.8);
      await shell(mp, tgt, 2.0 + d * 0.2, 0.42 + d * 0.03, 0.11);
      sfx.explode(); rig.shake(0.5);
      fx.explosion(V().copy(to), 0.5); fx.sparks(tgt, null, 50, 0xffe0a0, 10);
      await pose(0.18, [[p.rider.armR, -0.6]]);
      await aim(u, -(0.44 + d * 0.022), 0.22);
      mp = muzzleBlast(u, dir, 1.4);
      await shell(mp, tgt, 2.8 + d * 0.2, 0.5 + d * 0.035, 0.2);
      sfx.explode(); rig.shake(1.1);
      fx.explosion(V().copy(to), 1.35); scars.blast(to, 1.2);
      hit(dir, 'blast');
      await vault(u, to);
    },
  },
  P: {
    // vs foot: closes in and drives the spear home.
    async foot(u, to, dir, hit) {
      const p = u.parts;
      await walkTo(u, before(to, dir, 1.25), 0.26, 2, false);
      await thrust(u, p, p.weapon, dir, hit);
      u.rest();
      await walkTo(u, to, 0.3, 2, false);
    },
    // vs beast: ducks under it, shield overhead, and stabs straight up.
    async beast(u, to, dir, hit) {
      const p = u.parts;
      await walkTo(u, before(to, dir, 1.0), 0.3, 2, false);
      await tween(0.14, (t) => { p.g.position.y = -0.28 * t; p.torso.rotation.x = 0.5 * t; p.armR.rotation.x = lerp(-0.12, 0.7, t); p.weapon.rotation.x = lerp(0.12, 0.5, t); p.armL.rotation.x = lerp(-0.5, -1.9, t); });
      sfx.slash();
      await tween(0.08, (t) => { p.g.position.y = lerp(-0.28, 0.1, t); p.torso.rotation.x = lerp(0.5, -0.3, t); p.armR.rotation.x = lerp(0.7, -2.5, t); p.weapon.rotation.x = lerp(0.5, 0.2, t); });
      fx.slash(V().copy(u.root.position).addScaledVector(dir, 0.5).setY(u.root.position.y + 0.5), V().copy(dir).setY(1.5).normalize(), glowOf(u), { vertical: true, size: 1.1, travel: 1.9, dur: 0.28 });
      hit(dir, 'blade');
      await wait(0.35);
      await tween(0.15, (t) => { p.g.position.y = 0.1 * (1 - t); });
      u.rest();
      await walkTo(u, to, 0.3, 2, false);
    },
    // vs machine: hurls the spear through the crew, then walks in to collect it.
    async machine(u, to, dir, hit) {
      const p = u.parts;
      await walkTo(u, before(to, dir, 1.9), 0.16, 1, false);
      await tween(0.22, (t) => { p.armR.rotation.x = lerp(-0.12, -2.6, t); p.weapon.rotation.x = lerp(0.12, -2.1, t); p.torso.rotation.x = -0.25 * t; p.legL.rotation.x = -0.5 * t; p.legR.rotation.x = 0.4 * t; }, ease.out2);
      sfx.whoosh();
      await tween(0.07, (t) => { p.armR.rotation.x = lerp(-2.6, -0.9, t); p.torso.rotation.x = lerp(-0.25, 0.4, t); });
      // The thrown spear is a stand-in so the soldier's own weapon is never detached.
      const j = (p.weapon.userData.copy?.() ?? p.weapon.clone()) as THREE.Object3D, from = p.weapon.getWorldPosition(V()), tgt = V().copy(to).setY(to.y + 0.8), prev = V().copy(from), vel = V();
      p.weapon.getWorldScale(j.scale); p.weapon.visible = false;
      fx.scene.add(j);
      await tween(0.24, (t) => {
        j.position.lerpVectors(from, tgt, t); j.position.y += 1.6 * t * (1 - t);
        if (vel.subVectors(j.position, prev).lengthSq() > 1e-8) j.quaternion.setFromUnitVectors(UP, vel.normalize());
        j.position.addScaledVector(vel, -0.9); prev.copy(j.position).addScaledVector(vel, 0.9);
        fx.glow(prev, glowOf(u), 0.4, 0.25, 0.7);
      });
      sfx.clang(); fx.sparks(tgt, V().copy(dir).negate(), 30, 0xfff0c0, 8);
      fx.debris(j, V().set(randS(1.5), 4.5, randS(1.5)).addScaledVector(dir, -1.5), 10, 2, { stick: 1.45 });
      hit(dir, 'blade');
      await wait(0.45);
      u.rest();
      await walkTo(u, to, 0.42, 3, false);
      p.weapon.visible = true;
      fx.glow(p.weapon.getWorldPosition(V()), glowOf(u), 0.9, 0.3, 0.8);
    },
  },
};

async function elephantCharge(u: Unit, to: THREE.Vector3, headDown: number) {
  const p = u.parts, dir = flatDir(u.root.position, to);
  sfx.trumpet();
  const beat = beats(3, () => { sfx.stomp(0.7); rig.shake(0.22); fx.dust(u.root.position, 8, 1.2); scars.mark('foot', u.root.position, 1.5, 0.3, dir); });
  await travel(u, to, 0.6, ease.in2, (k) => { elephantPose(p, k * 3 * Math.PI, 0.55); beat(k); p.head.rotation.x = headDown * k; });
}
function elephantStomp(u: Unit, power: number) {
  sfx.stomp(1.3 * power); rig.shake(0.7 * power);
  fx.dust(u.root.position, 26 * power, 1.9); fx.shockwave(u.root.position, glowOf(u), 3.6 * power, 0.7); fx.shockwave(u.root.position, 0xffffff, 2.2 * power, 0.5);
  scars.mark('crack', u.root.position, 3.0 * power, 0.55);
}
/** Lay wheel ruts behind a rolling unit, one tile per unit of distance. */
function rutter(u: Unit, aspect: number, alpha: number) {
  let acc = 0.5;
  return (d: number) => {
    acc += d;
    if (acc < 1) return;
    acc = 0;
    scars.mark('rut', u.root.position, 1.05, alpha, { x: Math.sin(u.root.rotation.y), z: Math.cos(u.root.rotation.y) }, aspect);
  };
}

export async function playAttack(u: Unit, to: THREE.Vector3, victim: PType, hit: HitFn) {
  u.busy = true;
  const dir = flatDir(u.root.position, to);
  await faceTo(u, to, 0.14);
  await ATTACK[u.piece.type][klassOf(victim)](u, to, dir, hit);
  u.setXZ(to.x, to.z);
  await settle(u);
  u.busy = false;
}

/** The victim sees it coming: turn to face the attacker and brace. Must finish inside the cinematic lead-in. */
export async function playBrace(v: Unit, from: THREE.Vector3) {
  v.busy = true;
  const p = v.parts;
  await faceTo(v, from, 0.13);
  switch (v.piece.type) {
    case 'P': await pose(0.16, [[p.armL, -1.5], [p.torso, -0.12], [p.armR, -0.6], [p.weapon, 0.9]]); break;
    case 'A': await pose(0.16, [[p.armR, -1.0], [p.weapon, 1.35], [p.torso, -0.1]]); break;
    case 'N': await pose(0.18, [[p.hb, -0.4], [p.legs[0], -0.9], [p.legs[1], -0.6], [p.neck, -0.25]]); break;
    case 'B': await pose(0.18, [[p.head, -0.35], ...p.trunk.map((g: THREE.Group): [THREE.Object3D, number] => [g, -0.42])]); break;
    case 'R': await pose(0.16, [[p.rider.armR, -1.7], [p.weapon, 0.9]]); break;
    case 'C': await pose(0.16, [[p.rider.torso, 0.55], [p.rider.armL, -1.6]]); break;
  }
}

// ---------- DEATH ----------
type DeathFn = (v: Unit, dir: THREE.Vector3, kind: HitKind) => Promise<void>;

/** Tip the whole unit over so that its up axis falls towards `dir`. */
function topple(v: Unit, dir: THREE.Vector3, angle: number, dur: number, e = ease.in2) {
  const base = v.root.quaternion.clone(), axis = V().set(dir.z, 0, -dir.x).normalize(), q = new THREE.Quaternion();
  return tween(dur, (t) => { v.root.quaternion.copy(q.setFromAxisAngle(axis, angle * t)).multiply(base); }, e);
}
function shove(v: Unit, dir: THREE.Vector3, dist: number, dur: number, height = 0) {
  const x0 = v.root.position.x, z0 = v.root.position.z;
  return tween(dur, (t) => {
    const k = ease.out2(t), x = x0 + dir.x * dist * k, z = z0 + dir.z * dist * k;
    const floor = river.isWater(x, z) ? WATER_Y - 0.35 : Math.max(groundHeight(x, z), -0.1); // a body in the river sinks to the waist
    v.root.position.set(x, floor + 4 * height * t * (1 - t), z);
  });
}
/** Throw the unit through the air, tumbling `spins` times, trailing light. */
function launch(v: Unit, dir: THREE.Vector3, dist: number, height: number, dur: number, spins: number) {
  return Promise.all([
    shove(v, dir, dist, dur, height),
    tween(dur, (t) => {
      v.body.rotation.x = -t * Math.PI * 2 * spins; v.body.position.y = 0.6 * Math.sin(Math.PI * t);
      fx.glow(V().copy(v.root.position).setY(v.root.position.y + v.height * 0.5), glowOf(v), 0.7, 0.35, 0.6);
      if (Math.random() < 0.6) fx.embers(v.root.position, 1, glowOf(v), 0.4, 0.6);
    }),
  ]);
}
/** The body hits the ground: dust, flying paving, a shock ring, a cracked floor. */
function slam(v: Unit, power: number) {
  const p = v.root.position;
  if (river.isWater(p.x, p.z)) { river.splash(p, 0.7 + 0.5 * power); rig.shake(0.25 * power); return; } // into the river
  power > 1.2 ? sfx.stomp(power) : sfx.thud(); rig.shake(0.35 * power);
  fx.dust(p, 14 * power, 1 + 0.5 * power); fx.rubble(p, Math.round(5 * power), power);
  fx.shockwave(p, glowOf(v), 2.6 * power, 0.55); fx.shockwave(p, 0xffffff, 1.6 * power, 0.4);
  scars.mark('crack', p, 1.6 * power, 0.45);
}
const glyphOf = (v: Unit) => (v.badge.material as THREE.SpriteMaterial).map;
/** The moment of destruction: a pillar of the unit's colour, its glyph burning away, a burst of motes. */
function obliterate(v: Unit, pos: THREE.Vector3, size = 1) {
  fx.pillar(pos, glowOf(v), 9 + 3 * size, 0.55 + 0.25 * size, 0.9); fx.pillar(pos, 0xffffff, 6 + 2 * size, 0.2 * size, 0.6);
  fx.ghost(glyphOf(v), pos, v.height);
  fx.shockwave(pos, glowOf(v), 3.2 * size, 0.7); fx.embers(pos, Math.round(26 * size), glowOf(v), 0.7 * size, 3.5);
}
async function vanish(v: Unit, n = 70, radius = 0.5) {
  const size = radius * 2;
  fx.soul(v.root.position, v.height * 0.6, glowOf(v), n * 2, radius);
  fx.soul(v.root.position, v.height * 0.4, 0xffffff, n * 0.7, radius);
  obliterate(v, v.root.position, size);
  sfx.vanish(); rig.shake(0.2 * size);
  const s0 = v.root.scale.x;
  await tween(0.45, (t) => { v.root.scale.setScalar(Math.max(0.001, s0 * (1 - t))); v.root.position.y += 0.025; v.root.rotation.y += 0.25; }, ease.in2);
  v.dispose();
}
const fling = (dir: THREE.Vector3, fwd: number, up: number, spread = 1.5) => V().set(dir.x * fwd + randS(spread), up, dir.z * fwd + randS(spread));
/** Secondary blasts cooking off around a wreck. */
function cookOff(pos: THREE.Vector3, n: number, reach: number, size: number) {
  for (let i = 0; i < n; i++) void wait(0.18 + i * rand(0.1, 0.2)).then(() => {
    const q = V().set(pos.x + randS(reach), 0, pos.z + randS(reach));
    fx.explosion(q, size); fx.rubble(q, 3, 0.7); sfx.boom(0.45); rig.shake(0.25);
  });
}

const DEATH: Record<PType, DeathFn> = {
  // General (only as the checkmate finisher): kneels as the field erupts around him, sword and banner fall.
  async K(v) {
    const p = v.parts, pos = v.root.position;
    sfx.gong();
    fx.pillar(pos, 0xffffff, 16, 1.0, 1.4); fx.rubble(pos, 10, 1.2);
    fx.debris(p.banner, fling(V().set(Math.sin(v.root.rotation.y), 0, Math.cos(v.root.rotation.y)), -2, 5.5, 0.5), 5, 2.6, { keep: true });
    await tween(0.9, (t) => {
      p.legL.rotation.x = 1.45 * t; p.legR.rotation.x = 1.3 * t; p.g.position.y = -0.52 * t;
      p.torso.rotation.x = 0.55 * t; p.head.rotation.x = 0.5 * t; p.armR.rotation.x = lerp(0.1, -0.5, t); p.armL.rotation.x = -0.4 * t;
      p.wind.value = lerp(0.2, 0, t);
      fx.embers(pos, 2, glowOf(v), 1.2, 2.4);
    }, ease.outBounce);
    fx.debris(p.weapon, V().set(randS(1), 5.5, randS(1)), 6, 2.4, { stick: 0.9 });
    fx.dust(pos, 24, 1.6); scars.mark('crack', pos, 5.2, 0.65); rig.shake(0.9); sfx.stomp(1.4);
    for (let i = 0; i < 3; i++) void wait(i * 0.22).then(() => { fx.shockwave(pos, i % 2 ? 0xffffff : glowOf(v), 5 + i * 2.5, 1.2); fx.rubble(pos, 6, 1); });
    fx.ghost(glyphOf(v), pos, v.height); fx.pillar(pos, glowOf(v), 14, 0.9, 1.6);
    await wait(1.1);
  },
  // Guard: hurled spinning the length of the palace.
  async A(v, dir, kind) {
    sfx.grunt();
    fx.debris(v.parts.weapon, fling(dir, 3, 9), 14, 1.8, { stick: 1.76 });
    await launch(v, dir, kind === 'blade' ? 4.2 : 5.6, kind === 'blade' ? 2.3 : 3.1, 0.8, 4);
    slam(v, 1); scars.mark('stain', v.root.position, 1.6, 0.6);
    await tween(0.22, (t) => { v.body.position.y = 0.45 * Math.sin(Math.PI * t); }); // one bounce
    await vanish(v, 80);
  },
  // Elephant: bellows, is lifted off its feet and comes down like a falling wall.
  async B(v, dir) {
    const p = v.parts;
    sfx.trumpet(0.7);
    const h0 = p.head.rotation.x, tr0 = p.trunk.map((g: THREE.Group) => g.rotation.x);
    await tween(0.36, (t) => { p.head.rotation.x = lerp(h0, -0.7, t); p.eb.rotation.x = -0.3 * t; p.legs[0].rotation.x = p.legs[1].rotation.x = -1.1 * t; p.trunk.forEach((g: THREE.Group, i: number) => { g.rotation.x = lerp(tr0[i], -0.6, t); }); }, ease.out2);
    const side = V().set(Math.cos(v.root.rotation.y), 0, -Math.sin(v.root.rotation.y));
    if (side.dot(dir) < 0) side.negate();
    await Promise.all([topple(v, side, 1.5, 0.8), shove(v, dir, 1.4, 0.8, 0.9)]);
    slam(v, 2.2); rig.shake(0.6);
    scars.mark('crack', v.root.position, 4.2, 0.6); scars.mark('stain', v.root.position, 2.8, 0.55);
    for (let i = 1; i < 3; i++) void wait(i * 0.16).then(() => { fx.shockwave(v.root.position, 0xd0c0a0, 4 + i * 2, 0.8); fx.dust(v.root.position, 16, 2.4); });
    const y0 = v.root.position.y;
    await tween(0.3, (t) => { v.root.position.y = y0 + 0.35 * Math.sin(Math.PI * t); }); // the ground throws it back up once
    sfx.stomp(1); fx.dust(v.root.position, 20, 1.8); fx.rubble(v.root.position, 6, 1.2);
    await wait(0.35);
    await vanish(v, 150, 1.2);
  },
  // Horse: rears, hurls its rider skyward, then is thrown end over end.
  async N(v, dir) {
    const p = v.parts;
    sfx.neigh(0.8);
    const b0 = p.hb.rotation.x, l0 = p.legs[0].rotation.x, l1 = p.legs[1].rotation.x, n0 = p.neck.rotation.x;
    await tween(0.26, (t) => { p.hb.rotation.x = lerp(b0, -0.95, t); p.legs[0].rotation.x = lerp(l0, -1.2, t); p.legs[1].rotation.x = lerp(l1, -0.8, t); p.neck.rotation.x = lerp(n0, -0.4, t); }, ease.out2);
    fx.debris(p.rider.g, fling(dir, 5, 10), 11, 2.0);
    const side = V().set(Math.cos(v.root.rotation.y), 0, -Math.sin(v.root.rotation.y));
    if (side.dot(dir) < 0) side.negate();
    await Promise.all([topple(v, side, 1.5 + Math.PI * 2, 0.7, ease.lin), shove(v, dir, 2.6, 0.7, 1.7)]);
    slam(v, 1.4); scars.mark('stain', v.root.position, 2.0, 0.55);
    await wait(0.25);
    await vanish(v, 100, 0.8);
  },
  // Chariot: goes up in a fireball, wheels and panels raining across the field.
  async R(v, dir, kind) {
    const p = v.parts, pos = v.root.position.clone(), up = kind === 'crush' ? 0.5 : 1; // crushed wrecks splay out low
    sfx.crash(); sfx.explode(); rig.shake(1);
    fx.explosion(pos, kind === 'blast' ? 1.3 : 1.0); fx.fire(V().copy(pos).setY(0.6), 30, 1.8); fx.sparks(V().copy(pos).setY(0.6), dir, 90, 0xffb050, 13);
    fx.dust(pos, kind === 'crush' ? 40 : 24, 1.9); fx.rubble(pos, 9, 1.1);
    obliterate(v, pos, 1.1);
    scars.mark('scorch', pos, 3.2, 0.55); scars.mark('crack', pos, 2.4, 0.45);
    for (const w of p.wheels) fx.debris(w, fling(dir, rand(3, 8), rand(5, 9) * up, 6), 16, rand(2.0, 2.8), { keep: true, smoke: Math.random() < 0.5 });
    fx.debris(p.rider.g, fling(dir, 4, 10), 11, 2.0);
    for (const c of [...p.cb.children]) fx.debris(c, fling(dir, rand(2, 7), rand(5, 13) * up, 4.5), rand(6, 16), rand(1.3, 2.3), { smoke: Math.random() < 0.5, keep: Math.random() < 0.4 });
    v.dispose();
    cookOff(pos, 3, 1.3, 0.3);
    await wait(1.3);
  },
  // Cannon: the magazine goes up, the barrel cartwheels into the sky and the shot cooks off around it.
  async C(v, dir, kind) {
    const p = v.parts, pos = v.root.position.clone(), up = kind === 'crush' ? 0.55 : 1;
    await wait(0.08);
    sfx.explode(); sfx.boom(1); rig.shake(1.3);
    fx.explosion(pos, 1.8); scars.blast(pos, 1.3); fx.rubble(pos, 14, 1.3);
    obliterate(v, pos, 1.3);
    for (let i = 0; i < 26; i++) fx.smoke(V().set(pos.x + randS(0.8), 1.5 + rand(2.5), pos.z + randS(0.8)), 1, 1.6); // rising cap
    fx.debris(p.barrel, V().set(dir.x * 2.5 + randS(1), 17 * up, dir.z * 2.5 + randS(1)), 18, 3.2, { smoke: true, keep: true });
    for (const w of p.wheels) fx.debris(w, fling(dir, rand(3, 8), rand(6, 10) * up, 7), 16, 2.5, { keep: true, smoke: true });
    fx.debris(p.rider.g, fling(dir, 5, 11, 2), 12, 2.0);
    for (const c of [...p.cb.children]) fx.debris(c, fling(dir, rand(2, 6), rand(5, 12) * up, 4.5), 12, rand(1.4, 2.2), { smoke: Math.random() < 0.5, keep: Math.random() < 0.5 });
    v.dispose();
    cookOff(pos, 5, 1.8, 0.38);
    await wait(1.5);
  },
  // Soldier: launched off his feet, cartwheeling, to burst into light where he lands.
  async P(v, dir, kind) {
    sfx.grunt();
    fx.debris(v.parts.weapon, fling(dir, 3, 8), 12, 1.6, { stick: 1.45 });
    const big = kind !== 'blade';
    await launch(v, dir, big ? 4.2 : 2.6, big ? 2.6 : 1.8, 0.65, big ? 3 : 2);
    slam(v, 0.8); scars.mark('stain', v.root.position, 1.3, 0.6);
    await wait(0.12);
    await vanish(v, 60);
  },
};

export async function playDeath(v: Unit, dir: THREE.Vector3, kind: HitKind) {
  v.busy = true;
  v.badge.visible = false; v.ring.visible = false; v.pick.removeFromParent();
  await DEATH[v.piece.type](v, dir, kind);
  if (v.piece.type !== 'K') v.dispose();
}
