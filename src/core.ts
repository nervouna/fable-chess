// Shared game clock, tween scheduler, easing and board <-> world mapping.
import * as THREE from 'three';

// ---------- Board geometry ----------
export const S = 2; // distance between adjacent intersections
export const GAP = 1.2; // extra width added to the river
export const BANK = 1.0; // |z| of the stone terrace edge facing the river
export const WATER_Y = -0.2;
export const BRIDGE_X = [-6, 0, 6];
export const BRIDGE_HALF = 0.78;

export const colX = (c: number) => (c - 4) * S;
export const rowZ = (r: number) => (r - 4.5) * S + (r >= 5 ? GAP / 2 : -GAP / 2);
export const sqPos = (i: number, out = new THREE.Vector3()) => {
  const x = colX(i % 9), z = rowZ((i / 9) | 0);
  return out.set(x, groundHeight(x, z), z);
};

/** Walkable surface height: terraces at 0, river ford dips below water, bridges arch above. */
export function groundHeight(x: number, z: number): number {
  const az = Math.abs(z);
  if (az >= BANK) return 0;
  for (const bx of BRIDGE_X) if (Math.abs(x - bx) < BRIDGE_HALF) return 0.3 * Math.cos((az / BANK) * Math.PI * 0.5);
  const t = 1 - az / BANK;
  return -0.42 * smooth(Math.min(1, t / 0.6));
}
/** Centre line of the river beyond the board, where it meanders through the valley. */
export const riverCenter = (x: number) => { const k = smooth(clamp((Math.abs(x) - 12) / 28, 0, 1)); return (Math.sin(x * 0.045) * 9 + Math.sin(x * 0.11 + 1.3) * 2) * k; };
export const inWater = (x: number, z: number) => groundHeight(x, z) < WATER_Y + 0.05;
/** Stone terrace extents (the only flat ground that can carry decals and wreckage). */
export const TERRACE_X = 9.4, TERRACE_Z = 11;
/** Distance from (x, z) to the nearest terrace edge; negative when off the terrace. */
export const terraceInset = (x: number, z: number) => Math.min(TERRACE_X - Math.abs(x), TERRACE_Z - Math.abs(z), Math.abs(z) - BANK);

/** Remove an object and free the GPU buffers of every geometry under it (shared ones are flagged). */
export function disposeTree(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((c) => {
    const m = c as THREE.SkinnedMesh, g = m.geometry;
    if (m.isMesh && g && !g.userData.shared) g.dispose();
    if (m.isSkinnedMesh) m.skeleton.dispose(); // frees the bone texture; it is rebuilt if another piece still renders
  });
}

// ---------- Math ----------
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const rand = (a = 1, b?: number) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randS = (a = 1) => (Math.random() * 2 - 1) * a;
export const angDiff = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export const ease = {
  lin: (t: number) => t,
  in2: (t: number) => t * t,
  out2: (t: number) => 1 - (1 - t) * (1 - t),
  io2: (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  in3: (t: number) => t * t * t,
  out3: (t: number) => 1 - Math.pow(1 - t, 3),
  io3: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out5: (t: number) => 1 - Math.pow(1 - t, 5),
  outBack: (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t: number) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t: number) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

// ---------- Clock & tasks ----------
// One game clock drives every animation. `userScale` is for testing, `slow` for cinematic slow motion.
export const clock = { time: 0, real: 0, dt: 0, userScale: 1, slow: 1, slowLeft: 0, next: null as [number, number] | null };

type Task = (dt: number) => boolean; // return false to finish
const tasks = new Set<Task>();

/** Advance the clock by a real-time delta and run all scheduled tasks. */
export function tick(realDt: number) {
  clock.real += realDt;
  if (clock.slowLeft > 0) {
    clock.slowLeft -= realDt;
    if (clock.slowLeft <= 0) {
      if (clock.next) { [clock.slow, clock.slowLeft] = clock.next; clock.next = null; } else clock.slow = 1;
    }
  }
  const dt = realDt * clock.userScale * clock.slow;
  clock.dt = dt;
  clock.time += dt;
  for (const t of [...tasks]) if (!t(dt)) tasks.delete(t);
}

/** Slow motion for a real-time duration, optionally followed by a second [scale, duration] stage. */
export function slowmo(scale: number, realDuration: number, next: [number, number] | null = null) { clock.slow = scale; clock.slowLeft = realDuration; clock.next = next; }

export function every(fn: Task) { tasks.add(fn); return () => tasks.delete(fn); }

export function tween(dur: number, fn: (t: number) => void, e: (t: number) => number = ease.lin): Promise<void> {
  return new Promise((res) => {
    let el = 0;
    fn(e(0));
    tasks.add((dt) => {
      el += dt;
      const t = dur <= 0 ? 1 : Math.min(1, el / dur);
      fn(e(t));
      if (t >= 1) { res(); return false; }
      return true;
    });
  });
}

export const wait = (dur: number) => tween(dur, () => {});

export function clearTasks() { tasks.clear(); clock.slow = 1; clock.slowLeft = 0; clock.next = null; }
