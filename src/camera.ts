// Camera director: the single owner of the camera. Blends user orbit, per-turn auto rotation,
// capture cinematics and screen shake.
import * as THREE from 'three';
import type { Side } from './engine';
import { angDiff, clamp, lerp } from './core';

interface View { yaw: number; pitch: number; dist: number; target: THREE.Vector3 }

const DEF_PITCH = Math.PI / 4, DEF_DIST = 33;
const MIN_PITCH = 0.2, MAX_PITCH = 1.5, MIN_DIST = 8, MAX_DIST = 62;

class CameraRig {
  cam = new THREE.PerspectiveCamera(40, 1, 0.3, 900);
  private user: View = { yaw: 0, pitch: DEF_PITCH, dist: DEF_DIST, target: new THREE.Vector3(0, 0, 0.6) };
  private cur: View = { yaw: 0.9, pitch: 0.3, dist: 70, target: new THREE.Vector3(0, 2, 0) }; // opening fly-in start
  private cine: View | null = null;
  private trauma = 0;
  private orbit = { left: 0, rate: 0 };
  private dragging = false;
  private focusLeft = 0;
  private track: THREE.Vector3 | null = null;
  private fit = { user: 1, cine: 1 }; // distance multipliers that keep narrow (portrait) frames wide enough
  private defPitch = DEF_PITCH;
  private hold = 0; // seconds the director leaves zoom and tilt alone after the user adjusts them
  /** Spectator mode: the camera drifts around the battlefield on its own. */
  director = false;
  private t = 0;
  onClick: (ndc: THREE.Vector2) => void = () => {};
  onHover: (ndc: THREE.Vector2) => void = () => {};
  /** Touch double tap (the first tap has already gone to onClick). */
  onDoubleTap: () => void = () => {};
  get cinematic() { return !!this.cine; }
  /** Point the camera is currently looking at. */
  get focusPoint() { return this.cur.target; }

  init(dom: HTMLElement) {
    const pts = new Map<number, { x: number; y: number }>();
    let downX = 0, downY = 0, moved = 0, button = 0, touch = false;
    // Touch: once a second finger lands the gesture can no longer end in a tap. `two` is the last
    // two-finger frame (spread, angle, centroid y), re-seeded whenever the finger count changes.
    let multi = false, two: { d: number; a: number; y: number } | null = null, lastTap = { t: -1e9, x: 0, y: 0 };
    const slop = () => (touch ? 12 : 5);
    const ndc = (e: PointerEvent) => { const r = dom.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    const pair = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), a: Math.atan2(b.y - a.y, b.x - a.x), y: (a.y + b.y) / 2 };
    };
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic or already-gone pointer */ }
      this.dragging = true; this.hold = 12;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { downX = e.clientX; downY = e.clientY; moved = 0; button = e.button; touch = e.pointerType === 'touch'; multi = false; }
      if (pts.size >= 2) { multi = true; two = pair(); }
    });
    dom.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) { if (e.pointerType !== 'touch') this.onHover(ndc(e)); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2) {
        // Pinch zooms, twist turns the board, a shared vertical drag tilts.
        const n = pair(), o = two ?? n;
        this.user.dist = clamp(this.user.dist * (o.d / n.d), MIN_DIST, MAX_DIST);
        this.user.yaw += angDiff(o.a, n.a); // the board turns with the fingers
        this.user.pitch = clamp(this.user.pitch + (n.y - o.y) * 0.005, MIN_PITCH, MAX_PITCH);
        two = n; return;
      }
      if (multi) return; // the finger left over from a pinch: wait for it to lift
      moved = Math.max(moved, Math.hypot(e.clientX - downX, e.clientY - downY));
      if (moved < slop()) return;
      if (button === 2 || e.shiftKey) { // pan on the ground plane
        const k = this.user.dist * 0.0016, c = Math.cos(this.user.yaw), s = Math.sin(this.user.yaw);
        this.user.target.x = clamp(this.user.target.x - (dx * c + dy * s) * k, -12, 12);
        this.user.target.z = clamp(this.user.target.z - (-dx * s + dy * c) * k, -14, 14);
      } else {
        this.user.yaw -= dx * 0.006;
        this.user.pitch = clamp(this.user.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
      }
    });
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      this.dragging = pts.size > 0;
      two = pts.size >= 2 ? pair() : null;
      if (pts.size > 0 || multi || moved >= slop() || button !== 0 || e.type !== 'pointerup') return;
      if (touch) {
        // A second quick tap on the same spot resets the view instead of clicking again.
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 20) { lastTap.t = -1e9; this.onDoubleTap(); return; }
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      this.onClick(ndc(e));
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault(); this.hold = 12;
      this.user.dist = clamp(this.user.dist * Math.exp(e.deltaY * 0.0012), MIN_DIST, MAX_DIST);
    }, { passive: false });
  }

  setAspect(a: number) {
    this.cam.aspect = a;
    // Narrow (portrait) windows: widen the lens up to 60 degrees, then pull shots back until they are
    // as wide as needed (half-width tangents below). The board view only needs the board's width;
    // duels are shot side-on, so cinematics need at least a 40 degree, 1.25:1 field, growing towards
    // a 16:9 one in portrait. Wide windows (a >= 1.25) are untouched. Portrait also looks down more
    // steeply so the board fills the tall frame.
    this.cam.fov = a < 1.25 ? clamp(40 * (1.25 / a), 40, 60) : 40;
    const half = Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)) * a;
    this.fit = { user: Math.max(1, 0.34 / half), cine: Math.max(1, (0.455 + 0.145 * clamp((1.25 - a) / 0.5, 0, 1)) / half) };
    this.defPitch = a < 0.8 ? 0.98 : DEF_PITCH;
    this.cam.updateProjectionMatrix();
  }

  private sideYaw(side: Side) { return side === 'r' ? 0 : Math.PI; }

  /** One-key reset to the default view for the given side (45 degrees, steeper in portrait). */
  reset(side: Side) {
    this.user.yaw = this.cur.yaw + angDiff(this.cur.yaw, this.sideYaw(side));
    this.user.pitch = this.defPitch; this.user.dist = DEF_DIST; this.user.target.set(0, 0, side === 'r' ? 0.6 : -0.6);
  }

  /** Swing around to the side to move, keeping the user's zoom and tilt. */
  faceSide(side: Side) {
    this.user.yaw = this.user.yaw + angDiff(this.user.yaw, this.sideYaw(side));
    this.user.target.z = Math.abs(this.user.target.z) < 1 ? (side === 'r' ? 0.6 : -0.6) : this.user.target.z;
  }

  /** Close-up framing of an attacker (a) striking a victim (b). */
  cineStart(a: THREE.Vector3, b: THREE.Vector3, tight = 1) {
    this.focusLeft = 0;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    const along = Math.atan2(dx, dz), behind = along + Math.PI;
    const c1 = along + Math.PI / 2, c2 = along - Math.PI / 2;
    let yaw = Math.abs(angDiff(this.cur.yaw, c1)) < Math.abs(angDiff(this.cur.yaw, c2)) ? c1 : c2;
    yaw += angDiff(yaw, behind) * 0.28;
    yaw = this.cur.yaw + angDiff(this.cur.yaw, yaw);
    this.cine = {
      yaw, pitch: 0.42, dist: clamp(8.5 + d * 1.05, 10, 26) * tight,
      target: new THREE.Vector3(lerp(a.x, b.x, 0.58), 0.9, lerp(a.z, b.z, 0.58)),
    };
  }
  cineEnd() { this.cine = null; this.orbit.left = 0; this.focusLeft = 0; this.track = null; }
  /** Keep the cinematic framed on a moving point (a unit thrown across the board). */
  cineFollow(p: THREE.Vector3) { if (this.cine) this.track = p; }
  /** Director: push in on a point for a few real seconds (no letterbox), then drift back. */
  focus(p: THREE.Vector3, secs: number) {
    if (this.cine) return;
    this.cine = { yaw: this.cur.yaw + 0.5, pitch: 0.5, dist: 15, target: new THREE.Vector3(p.x, 1, p.z) };
    this.orbit = { left: 0.5, rate: 0.5 / secs }; this.focusLeft = secs;
  }
  /** Director: lean the framing towards where the action is. */
  glance(p: THREE.Vector3) { if (this.director && !this.dragging) this.user.target.set(p.x * 0.35, 0, p.z * 0.35); }
  /** Director: pull back to take in the whole field. */
  wide() { this.hold = 9; this.user.dist = 44; this.user.pitch = 0.62; this.user.target.set(0, 0, 0); }
  /** Bullet-time move: push in and swing `angle` radians around the action over `secs` of real time. */
  cineOrbit(angle: number, secs: number) {
    if (!this.cine) return;
    this.orbit = { left: Math.abs(angle), rate: angle / secs };
    this.cine.dist *= 0.8; this.cine.pitch = 0.3;
  }

  shake(amount: number) { this.trauma = Math.min(1.2, this.trauma + amount); }

  update(dt: number) {
    this.t += dt;
    if (this.focusLeft > 0) { this.focusLeft -= dt; if (this.focusLeft <= 0) { this.cine = null; this.orbit.left = 0; } }
    if (this.director && !this.cine && !this.dragging) {
      this.user.yaw += dt * 0.055;
      this.hold -= dt;
      if (this.hold <= 0) {
        this.user.pitch += (0.74 + 0.1 * Math.sin(this.t * 0.11) - this.user.pitch) * Math.min(1, dt * 0.3);
        this.user.dist += (29 + 4 * Math.sin(this.t * 0.07) - this.user.dist) * Math.min(1, dt * 0.25);
      }
    }
    if (this.cine && this.track) {
      const k2 = 1 - Math.exp(-dt * 5), t = this.cine.target;
      t.x += (this.track.x - t.x) * k2; t.z += (this.track.z - t.z) * k2; t.y += (Math.min(2.2, this.track.y + 0.9) - t.y) * k2;
    }
    if (this.cine && this.orbit.left > 0) {
      const d = Math.min(this.orbit.left, Math.abs(this.orbit.rate) * dt);
      this.cine.yaw += Math.sign(this.orbit.rate) * d; this.orbit.left -= d;
    }
    const g = this.cine ?? this.user, k = 1 - Math.exp(-dt * (this.cine ? 5.5 : 4.2)), c = this.cur;
    c.yaw += angDiff(c.yaw, g.yaw) * k;
    c.pitch = lerp(c.pitch, g.pitch, k); c.dist = lerp(c.dist, g.dist * (this.cine ? this.fit.cine : this.fit.user), k);
    c.target.lerp(g.target, k);
    // Keep yaw values bounded without a visible jump.
    if (!this.cine && Math.abs(c.yaw) > 50) { const n = Math.round(c.yaw / (Math.PI * 2)) * Math.PI * 2; c.yaw -= n; this.user.yaw -= n; }
    const cp = Math.cos(c.pitch);
    this.cam.position.set(c.target.x + Math.sin(c.yaw) * cp * c.dist, c.target.y + Math.sin(c.pitch) * c.dist, c.target.z + Math.cos(c.yaw) * cp * c.dist);
    this.cam.lookAt(c.target);
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * 0.55, t = this.t * 38;
      this.cam.position.x += Math.sin(t * 1.1) * s; this.cam.position.y += Math.sin(t * 1.7 + 1) * s; this.cam.position.z += Math.sin(t * 1.3 + 2) * s;
      this.cam.rotation.z += Math.sin(t * 0.9) * s * 0.03;
    }
  }
}

export const rig = new CameraRig();
