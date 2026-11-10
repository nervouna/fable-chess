// Procedural low-poly models for the seven unit types, plus the Unit wrapper used by the game.
import * as THREE from 'three';
import type { Piece, PType, Side } from './engine';
import { disposeTree, groundHeight, rand, sqPos } from './core';
import { fx } from './fx';
import { box, clothMat, cone, cyl, glyphTexture, group, mesh, sph, std, TEAM } from './kit';
import { dropModels, instantiate, model, useModels } from './models';
import type { Detail } from './quality';

export const GLYPH: Record<Side, Record<PType, string>> = {
  r: { K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵' },
  b: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' },
};
const HEIGHT: Record<PType, number> = { K: 2.35, A: 1.95, B: 2.75, N: 2.2, R: 2.35, C: 1.55, P: 1.65 };

// ---------- materials ----------
function makeMats(side: Side) {
  const T = TEAM[side], red = side === 'r';
  return {
    cloth: std(T.main, { roughness: 0.75 }),
    clothDark: std(T.dark, { roughness: 0.85 }),
    armor: std(red ? 0x8e1c16 : 0x2b3442, { roughness: 0.45, metalness: red ? 0.35 : 0.65 }),
    trim: std(T.trim, { roughness: 0.32, metalness: 0.95 }),
    glow: new THREE.MeshStandardMaterial({ color: T.glow, emissive: T.glow, emissiveIntensity: 2.4, roughness: 0.4 }),
    skin: std(0xdcae86, { roughness: 0.8 }),
    leather: std(0x3a281a, { roughness: 0.9 }),
    wood: std(0x6a482a, { roughness: 0.85 }),
    darkWood: std(0x3d2a1a, { roughness: 0.9 }),
    iron: std(0xaab2bc, { roughness: 0.28, metalness: 1 }),
    bronze: std(red ? 0xb98a45 : 0x4f8f86, { roughness: 0.4, metalness: 0.95 }),
    coat: std(red ? 0x8b5a36 : 0x24201f, { roughness: 0.8 }),
    mane: std(red ? 0x2a1a10 : 0x8a9aa8, { roughness: 0.9 }),
    hide: std(red ? 0x8b8378 : 0x565a66, { roughness: 0.92 }),
    ivory: std(0xf3ead6, { roughness: 0.4 }),
    black: std(0x0b0a0a, { roughness: 1 }),
  };
}
type Mats = ReturnType<typeof makeMats>;
const MATS: Record<Side, Mats | null> = { r: null, b: null };
const mats = (s: Side) => (MATS[s] ??= makeMats(s));

// ---------- humanoid ----------
type Helmet = 'general' | 'guard' | 'hat' | 'plain';
function human(M: Mats, helmet: Helmet, o: { robe?: boolean; pads?: boolean } = {}) {
  const g = group();
  const mkLeg = (sx: number) => {
    const l = group(sx * 0.11, 0.62, 0, g);
    mesh(box(0.15, 0.6, 0.17), M.clothDark, 0, -0.3, 0, l);
    mesh(box(0.17, 0.13, 0.25), M.leather, 0, -0.555, 0.035, l);
    return l;
  };
  const legL = mkLeg(-1), legR = mkLeg(1);
  const torso = group(0, 0.62, 0, g);
  mesh(box(0.44, 0.5, 0.27), M.armor, 0, 0.27, 0, torso);
  mesh(box(0.47, 0.08, 0.3), M.trim, 0, 0.04, 0, torso);
  mesh(box(0.28, 0.24, 0.04), M.trim, 0, 0.33, 0.14, torso);
  if (o.robe) mesh(cyl(0.25, 0.42, 0.6, 8), M.cloth, 0, -0.28, 0, torso);
  else mesh(cyl(0.25, 0.34, 0.3, 8), M.cloth, 0, -0.1, 0, torso);
  const head = group(0, 0.56, 0, torso);
  mesh(cyl(0.07, 0.08, 0.1, 6), M.skin, 0, 0, 0, head);
  mesh(sph(0.155, 8, 6), M.skin, 0, 0.16, 0, head);
  if (helmet === 'general') {
    mesh(cyl(0.175, 0.17, 0.13, 8), M.trim, 0, 0.26, 0, head);
    mesh(cone(0.15, 0.2, 8), M.armor, 0, 0.42, 0, head);
    mesh(sph(0.05, 6, 5), M.glow, 0, 0.3, 0.16, head);
    for (const sx of [-1, 1]) { // long pheasant plumes
      const f = mesh(cone(0.028, 0.95, 5), M.glow, sx * 0.1, 0.8, -0.2, head);
      f.rotation.set(-0.55, 0, -sx * 0.3);
    }
  } else if (helmet === 'guard') {
    mesh(sph(0.17, 8, 6).scale(1, 0.8, 1), M.iron, 0, 0.22, 0, head);
    mesh(cone(0.05, 0.22, 6), M.cloth, 0, 0.44, 0, head);
    mesh(box(0.32, 0.12, 0.1), M.iron, 0, 0.13, -0.12, head);
  } else if (helmet === 'hat') {
    mesh(cone(0.3, 0.16, 10), M.wood, 0, 0.33, 0, head);
  } else {
    mesh(sph(0.17, 8, 6).scale(1, 0.75, 1), M.armor, 0, 0.22, 0, head);
    mesh(sph(0.04, 5, 4), M.trim, 0, 0.36, 0, head);
  }
  const mkArm = (sx: number) => {
    const a = group(sx * 0.29, 0.46, 0, torso);
    mesh(box(0.12, 0.44, 0.12), M.cloth, 0, -0.2, 0, a);
    mesh(sph(0.07, 6, 5), M.skin, 0, -0.45, 0, a);
    if (o.pads !== false) mesh(sph(0.13, 6, 5).scale(1.1, 0.7, 1.1), M.trim, sx * 0.02, 0.03, 0, a);
    return a;
  };
  const armL = mkArm(-1), armR = mkArm(1);
  return { g, torso, head, armL, armR, legL, legR };
}
type Human = ReturnType<typeof human>;

function polearm(M: Mats, kind: 'spear' | 'halberd' | 'glaive' | 'ge', len = 1.9) {
  const w = group();
  mesh(cyl(0.022, 0.022, len, 6), M.darkWood, 0, len / 2 - 0.6, 0, w);
  const top = len - 0.6;
  if (kind === 'spear') {
    mesh(cone(0.05, 0.3, 4), M.iron, 0, top + 0.15, 0, w);
    mesh(cone(0.07, 0.14, 6), M.cloth, 0, top - 0.05, 0, w).rotation.x = Math.PI;
  } else if (kind === 'halberd') {
    mesh(cone(0.05, 0.36, 4), M.iron, 0, top + 0.18, 0, w);
    const b = mesh(cyl(0.2, 0.2, 0.025, 10, ), M.iron, 0, top - 0.08, 0.1, w); b.rotation.z = Math.PI / 2; b.scale.set(1, 1, 0.7);
    mesh(cone(0.08, 0.2, 6), M.glow, 0, top - 0.3, 0, w).rotation.x = Math.PI;
  } else if (kind === 'glaive') {
    const b = mesh(box(0.03, 0.62, 0.17), M.iron, 0, top + 0.28, 0.04, w); b.rotation.x = 0.1;
    mesh(cone(0.085, 0.2, 4), M.iron, 0, top + 0.66, 0.085, w).scale.set(0.2, 1, 1);
    mesh(cyl(0.05, 0.05, 0.06, 6), M.trim, 0, top - 0.04, 0, w);
    mesh(cone(0.06, 0.16, 6), M.glow, 0, top - 0.16, 0, w).rotation.x = Math.PI;
  } else {
    mesh(cone(0.04, 0.26, 4), M.bronze, 0, top + 0.13, 0, w);
    const b = mesh(cone(0.05, 0.36, 4), M.bronze, 0, top - 0.05, 0.16, w); b.rotation.x = Math.PI / 2; b.scale.x = 0.3;
  }
  return w;
}

function sword(M: Mats) {
  const w = group();
  mesh(box(0.055, 0.85, 0.018), new THREE.MeshStandardMaterial({ color: 0xe8eef8, metalness: 1, roughness: 0.15, emissive: M.glow.color, emissiveIntensity: 0.35 }), 0, 0.5, 0, w);
  mesh(box(0.2, 0.035, 0.05), M.trim, 0, 0.07, 0, w);
  mesh(cyl(0.02, 0.02, 0.16, 6), M.leather, 0, -0.02, 0, w);
  return w;
}

// ---------- builders ----------
// Every builder returns { parts, rest } where rest() restores the neutral pose.
type Built = { parts: any; rest: () => void; skeleton?: THREE.Skeleton };
const KING_FLAG: Partial<Record<Side, THREE.Texture>> = {}; // one banner texture per side, reused across games

function buildKing(M: Mats, side: Side, body: THREE.Group): Built {
  const h = human(M, 'general');
  h.g.scale.setScalar(1.36); body.add(h.g);
  const weapon = sword(M); weapon.position.y = -0.45; h.armR.add(weapon);
  const wind = { value: 0.15 };
  const cape = mesh(new THREE.PlaneGeometry(0.66, 1.0, 6, 10).translate(0, -0.5, 0), clothMat(TEAM[side].main, null, 'cape', wind), 0, 0.5, -0.15, h.torso);
  mesh(box(0.5, 0.06, 0.06), M.trim, 0, 0.5, -0.15, h.torso);
  const banner = group(0, 0.2, -0.17, h.torso);
  mesh(cyl(0.018, 0.018, 1.5, 5), M.trim, 0, 0.75, 0, banner);
  const flag = mesh(new THREE.PlaneGeometry(0.5, 0.62, 6, 4).translate(0.25, 0, 0),
    clothMat(0xffffff, (KING_FLAG[side] ??= glyphTexture(GLYPH[side].K, { w: 128, h: 160, bg: side === 'r' ? '#b3221c' : '#1b2636', fg: '#f6d27a', size: 96, border: '#e2b04a' })), 'flag'), 0, 1.15, 0, banner);
  flag.rotation.y = Math.PI / 2;
  const rest = () => {
    h.armR.rotation.set(0.1, 0, -0.12); weapon.rotation.set(2.2, 0, 0);
    h.armL.rotation.set(0, 0, 0.12); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.head.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0);
  };
  return { parts: { ...h, weapon, cape, wind, banner }, rest };
}

function buildAdvisor(M: Mats, _s: Side, body: THREE.Group): Built {
  const h = human(M, 'guard', { robe: true });
  h.g.scale.setScalar(1.12); body.add(h.g);
  const weapon = polearm(M, 'halberd', 2.0); weapon.position.y = -0.45; h.armR.add(weapon);
  const sash = mesh(box(0.1, 0.5, 0.03), M.glow, 0, -0.2, 0.2, h.torso); sash.castShadow = false;
  const rest = () => {
    h.armR.rotation.set(-0.15, 0, -0.1); weapon.rotation.set(0.15, 0, 0);
    h.armL.rotation.set(0, 0, 0.1); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0); h.g.rotation.set(0, 0, 0);
  };
  return { parts: { ...h, weapon }, rest };
}

function buildPawn(M: Mats, _s: Side, body: THREE.Group): Built {
  const h = human(M, 'hat', { pads: false });
  h.g.scale.setScalar(0.96); body.add(h.g);
  const weapon = polearm(M, 'spear', 1.75); weapon.position.y = -0.45; h.armR.add(weapon);
  const shield = group(-0.08, -0.3, 0.1, h.armL);
  mesh(cyl(0.27, 0.27, 0.04, 10), M.cloth, 0, 0, 0, shield).rotation.x = Math.PI / 2;
  mesh(sph(0.08, 6, 5), M.trim, 0, 0, 0.03, shield);
  mesh(new THREE.TorusGeometry(0.26, 0.025, 5, 14), M.trim, 0, 0, 0.01, shield);
  const rest = () => {
    h.armR.rotation.set(-0.12, 0, -0.08); weapon.rotation.set(0.12, 0, 0);
    h.armL.rotation.set(-0.5, 0, 0.15); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0);
  };
  return { parts: { ...h, weapon, shield }, rest };
}

function horse(M: Mats) {
  const g = group();
  const hb = group(0, 0.98, 0, g);
  mesh(sph(0.5, 10, 8).scale(0.64, 0.68, 1.25), M.coat, 0, 0, 0, hb);
  mesh(box(0.68, 0.36, 0.66), M.cloth, 0, 0.06, -0.06, hb);
  mesh(box(0.7, 0.05, 0.68), M.trim, 0, -0.12, -0.06, hb);
  mesh(box(0.5, 0.1, 0.5), M.leather, 0, 0.3, -0.05, hb);
  mesh(box(0.66, 0.3, 0.1), M.armor, 0, 0.02, 0.56, hb); // chest plate
  const neck = group(0, 0.2, 0.5, hb);
  const nm = mesh(box(0.2, 0.62, 0.28), M.coat, 0, 0.24, 0.1, neck); nm.rotation.x = 0.5;
  const mm = mesh(box(0.05, 0.6, 0.12), M.mane, 0, 0.3, -0.06, neck); mm.rotation.x = 0.5;
  const hd = group(0, 0.5, 0.26, neck);
  const hm = mesh(box(0.17, 0.2, 0.46), M.coat, 0, -0.05, 0.14, hd); hm.rotation.x = 0.55;
  const ch = mesh(box(0.19, 0.05, 0.36), M.trim, 0, 0.05, 0.13, hd); ch.rotation.x = 0.55;
  mesh(sph(0.035, 5, 4), M.glow, 0, 0.1, 0.1, hd);
  for (const sx of [-1, 1]) mesh(cone(0.035, 0.12, 4), M.coat, sx * 0.06, 0.12, -0.02, hd);
  const tail = group(0, 0.14, -0.6, hb);
  const tm = mesh(cone(0.09, 0.75, 6), M.mane, 0, -0.3, -0.12, tail); tm.rotation.x = Math.PI + 0.4;
  const legs: THREE.Group[] = [], knees: THREE.Group[] = [];
  for (const sz of [1, -1]) for (const sx of [-1, 1]) {
    const l = group(sx * 0.19, -0.14, sz * 0.42, hb);
    mesh(box(0.13, 0.46, 0.16), M.coat, 0, -0.2, 0, l);
    const k = group(0, -0.42, 0, l);
    mesh(box(0.095, 0.4, 0.11), M.coat, 0, -0.19, 0, k);
    mesh(box(0.12, 0.09, 0.14), M.black, 0, -0.385, 0.01, k);
    legs.push(l); knees.push(k);
  }
  return { g, hb, neck, hd, tail, legs, knees };
}

function buildHorse(M: Mats, _s: Side, body: THREE.Group): Built {
  const hs = horse(M); body.add(hs.g);
  const r = human(M, 'plain');
  r.g.scale.setScalar(0.8); r.g.position.set(0, 0.36 - 0.62 * 0.8, -0.05); hs.hb.add(r.g);
  const weapon = polearm(M, 'glaive', 1.7); weapon.position.y = -0.45; r.armR.add(weapon);
  const rest = () => {
    hs.hb.rotation.set(0, 0, 0); hs.hb.position.set(0, 0.98, 0); hs.neck.rotation.set(0, 0, 0); hs.tail.rotation.set(0, 0, 0);
    hs.legs.forEach((l) => l.rotation.set(0, 0, 0)); hs.knees.forEach((k) => k.rotation.set(0, 0, 0));
    r.legL.rotation.set(-0.5, 0, -0.55); r.legR.rotation.set(-0.5, 0, 0.55);
    r.armR.rotation.set(-0.2, 0, -0.25); weapon.rotation.set(0.2, 0, 0); r.armL.rotation.set(-0.7, 0, 0);
    r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { ...hs, rider: r, weapon }, rest };
}

// ---------- authored models ----------
// Each builder maps the model's bones onto the same part names and rest pose as the procedural
// build of that unit, so the choreography cannot tell them apart.
type B = Record<string, THREE.Bone>;
const fine = (name: string, M: Mats, side: Side, body: THREE.Group) =>
  instantiate(model(name)!, body, (n) => (M[n as keyof Mats] ?? M.cloth) as THREE.MeshStandardMaterial, `${name}-${side}`);
const riderOf = (b: B) => ({ g: b.rider, torso: b.r_torso, head: b.r_head, armL: b.r_armL, armR: b.r_armR, legL: b.r_legL, legR: b.r_legR });
const footOf = (b: B) => ({ g: b.g, torso: b.torso, head: b.head, armL: b.armL, armR: b.armR, legL: b.legL, legR: b.legR });

function fineKing(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('king', M, side, body), h = footOf(b);
  b.g.scale.setScalar(1.36);
  const wind = { value: 0.15 };
  const cape = mesh(new THREE.PlaneGeometry(0.66, 1.0, 6, 10).translate(0, -0.5, 0), clothMat(TEAM[side].main, null, 'cape', wind), 0, 0.5, -0.17, b.torso);
  const flag = mesh(new THREE.PlaneGeometry(0.5, 0.62, 6, 4).translate(0.25, 0, 0),
    clothMat(0xffffff, (KING_FLAG[side] ??= glyphTexture(GLYPH[side].K, { w: 128, h: 160, bg: side === 'r' ? '#b3221c' : '#1b2636', fg: '#f6d27a', size: 96, border: '#e2b04a' })), 'flag'), 0, 1.15, 0, b.banner);
  flag.rotation.y = Math.PI / 2;
  const rest = () => {
    h.armR.rotation.set(0.1, 0, -0.12); b.weapon.rotation.set(2.2, 0, 0);
    h.armL.rotation.set(0, 0, 0.12); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.head.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0);
  };
  return { parts: { ...h, weapon: b.weapon, cape, wind, banner: b.banner }, rest, skeleton };
}

function fineAdvisor(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('advisor', M, side, body), h = footOf(b);
  b.g.scale.setScalar(1.12);
  const rest = () => {
    h.armR.rotation.set(-0.15, 0, -0.1); b.weapon.rotation.set(0.15, 0, 0);
    h.armL.rotation.set(0, 0, 0.1); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0); h.g.rotation.set(0, 0, 0);
  };
  return { parts: { ...h, weapon: b.weapon }, rest, skeleton };
}

function finePawn(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('pawn', M, side, body), h = footOf(b);
  b.g.scale.setScalar(0.96);
  const rest = () => {
    h.armR.rotation.set(-0.12, 0, -0.08); b.weapon.rotation.set(0.12, 0, 0);
    h.armL.rotation.set(-0.5, 0, 0.15); h.legL.rotation.set(0, 0, 0); h.legR.rotation.set(0, 0, 0);
    h.torso.rotation.set(0, 0, 0); h.g.position.set(0, 0, 0);
  };
  return { parts: { ...h, weapon: b.weapon, shield: b.armL }, rest, skeleton };
}

function fineHorse(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('horse', M, side, body), r = riderOf(b);
  const legs = [b.leg0, b.leg1, b.leg2, b.leg3], knees = [b.knee0, b.knee1, b.knee2, b.knee3];
  const rest = () => {
    b.hb.rotation.set(0, 0, 0); b.hb.position.set(0, 0.98, 0); b.neck.rotation.set(0, 0, 0); b.tail.rotation.set(0, 0, 0);
    legs.forEach((l) => l.rotation.set(0, 0, 0)); knees.forEach((k) => k.rotation.set(0, 0, 0));
    r.legL.rotation.set(-0.5, 0, -0.55); r.legR.rotation.set(-0.5, 0, 0.55);
    r.armR.rotation.set(-0.2, 0, -0.25); b.weapon.rotation.set(0.2, 0, 0); r.armL.rotation.set(-0.7, 0, 0);
    r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { g: b.g, hb: b.hb, neck: b.neck, hd: b.hd, tail: b.tail, tailChain: [b.tail1, b.tail2, b.tail3], legs, knees, rider: r, weapon: b.weapon }, rest, skeleton };
}

function fineElephant(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('elephant', M, side, body), r = riderOf(b);
  b.g.scale.setScalar(0.74);
  const trunk = [0, 1, 2, 3, 4, 5, 6].map((i) => b['trunk' + i]), legs = [b.leg0, b.leg1, b.leg2, b.leg3], ears = [b.ear0, b.ear1];
  const rest = () => {
    b.eb.rotation.set(0, 0, 0); b.eb.position.set(0, 1.25, 0); b.head.rotation.set(0, 0, 0);
    trunk.forEach((s, i) => s.rotation.set(i === 0 ? -0.25 : i > 4 ? -0.35 : 0.02, 0, 0));
    legs.forEach((l) => l.rotation.set(0, 0, 0)); ears.forEach((e) => e.rotation.set(0, 0, 0));
    r.armR.rotation.set(-0.2, 0, -0.2); b.weapon.rotation.set(0.2, 0, 0);
  };
  return { parts: { eb: b.eb, head: b.head, ears, trunk, tusks: [], legs, tail: b.tail, rider: r, weapon: b.weapon }, rest, skeleton };
}

function fineChariot(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('chariot', M, side, body), r = riderOf(b);
  const flag = mesh(new THREE.PlaneGeometry(0.7, 0.42, 8, 3).translate(0.35, 0, 0), clothMat(TEAM[side].main, null, 'flag'), 0, 0.43, 0, b.pole);
  flag.rotation.y = Math.PI / 2;
  const rest = () => {
    b.cb.rotation.set(0, 0, 0); b.cb.position.set(0, 0.5, 0);
    r.armR.rotation.set(-0.2, 0, -0.2); b.weapon.rotation.set(0.2, 0, 0); r.armL.rotation.set(-0.9, 0, 0.2); r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { cb: b.cb, wheels: [b.wheel0, b.wheel1, b.wheel2, b.wheel3], rider: r, weapon: b.weapon, flag }, rest, skeleton };
}

function fineCannon(M: Mats, side: Side, body: THREE.Group): Built {
  const { bones: b, skeleton } = fine('cannon', M, side, body), r = riderOf(b);
  const rest = () => {
    b.cb.rotation.set(0, 0, 0); b.cb.position.set(0, 0, 0); b.barrel.rotation.set(-0.08, 0, 0);
    r.armR.rotation.set(-0.5, 0, -0.1); b.weapon.rotation.set(0.3, 0, 0); r.armL.rotation.set(0, 0, 0.1);
    r.legL.rotation.set(0, 0, 0); r.legR.rotation.set(0, 0, 0); r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { cb: b.cb, wheels: [b.wheel0, b.wheel1], barrel: b.barrel, muzzle: b.muzzle, rider: r, weapon: b.weapon, torch: b.torch }, rest, skeleton };
}

function buildElephant(M: Mats, side: Side, body: THREE.Group): Built {
  const g = group(0, 0, 0, body); g.scale.setScalar(0.74);
  const eb = group(0, 1.25, 0, g);
  mesh(sph(0.6, 12, 9).scale(1.05, 1.0, 1.55), M.hide, 0, 0, 0, eb);
  mesh(sph(0.6, 12, 9).scale(1.1, 1.05, 0.95), M.cloth, 0, 0.02, -0.02, eb);
  for (const sz of [-1, 1]) mesh(new THREE.TorusGeometry(0.61, 0.035, 5, 18), M.trim, 0, 0.02, -0.02 + sz * 0.42, eb).scale.set(1.0, 0.98, 1);
  const head = group(0, 0.12, 0.84, eb);
  mesh(sph(0.43, 10, 8).scale(1, 1.08, 1), M.hide, 0, 0, 0.2, head);
  mesh(box(0.42, 0.34, 0.06), M.trim, 0, 0.2, 0.6, head).rotation.x = -0.5;
  mesh(sph(0.07, 6, 5), M.glow, 0, 0.22, 0.64, head);
  for (const sx of [-1, 1]) mesh(sph(0.035, 5, 4), M.black, sx * 0.27, 0.06, 0.52, head);
  const ears = [-1, 1].map((sx) => {
    const e = group(sx * 0.36, 0.12, 0.14, head);
    const d = mesh(cyl(0.4, 0.4, 0.05, 10), M.hide, sx * 0.34, -0.05, 0, e); d.rotation.x = Math.PI / 2; d.scale.set(1, 1, 1.25);
    return e;
  });
  const trunk: THREE.Group[] = [];
  let par: THREE.Object3D = head, r0 = 0.15;
  for (let i = 0; i < 7; i++) {
    const s: THREE.Group = group(0, i === 0 ? -0.1 : -0.21, i === 0 ? 0.56 : 0, par);
    const r1 = r0 * 0.86;
    mesh(cyl(r0, r1, 0.23, 7), M.hide, 0, -0.105, 0, s);
    trunk.push(s); par = s; r0 = r1;
  }
  const tusks = [-1, 1].map((sx) => {
    const t = group(sx * 0.2, -0.2, 0.46, head);
    mesh(cone(0.065, 0.7, 6), M.ivory, 0, 0.35, 0, t);
    mesh(cyl(0.075, 0.075, 0.08, 6), M.trim, 0, 0.06, 0, t);
    t.rotation.set(Math.PI / 2 - 0.4, 0, -sx * 0.18);
    return t;
  });
  const legs = [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => {
    const l = group(sx * 0.36, -0.3, sz * 0.56, eb);
    mesh(cyl(0.19, 0.22, 0.96, 8), M.hide, 0, -0.47, 0, l);
    mesh(cyl(0.225, 0.225, 0.07, 8), M.trim, 0, -0.78, 0, l);
    return l;
  });
  const tail = group(0, 0.2, -0.9, eb);
  mesh(cyl(0.03, 0.02, 0.6, 5), M.hide, 0, -0.3, 0, tail); tail.rotation.x = 0.3;
  // Howdah with canopy
  const hw = group(0, 0.62, -0.05, eb);
  mesh(box(0.95, 0.1, 0.95), M.trim, 0, 0, 0, hw);
  for (const [w, d, x, z] of [[0.95, 0.06, 0, 0.45], [0.95, 0.06, 0, -0.45], [0.06, 0.95, 0.45, 0], [0.06, 0.95, -0.45, 0]]) mesh(box(w, 0.28, d), M.armor, x, 0.18, z, hw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(cyl(0.025, 0.025, 1.0, 5), M.trim, sx * 0.43, 0.55, sz * 0.43, hw);
  const roof = mesh(cone(0.82, 0.4, 4), M.cloth, 0, 1.24, 0, hw); roof.rotation.y = Math.PI / 4;
  mesh(sph(0.07, 6, 5), M.glow, 0, 1.48, 0, hw);
  const r = human(M, 'plain'); r.g.scale.setScalar(0.72); r.g.position.set(0, -0.2, 0); hw.add(r.g);
  const weapon = polearm(M, 'spear', 1.5); weapon.position.y = -0.45; r.armR.add(weapon);
  void side;
  const rest = () => {
    eb.rotation.set(0, 0, 0); eb.position.set(0, 1.25, 0); head.rotation.set(0, 0, 0);
    trunk.forEach((s, i) => s.rotation.set(i === 0 ? -0.25 : i > 4 ? -0.35 : 0.02, 0, 0));
    legs.forEach((l) => l.rotation.set(0, 0, 0)); ears.forEach((e) => e.rotation.set(0, 0, 0));
    r.armR.rotation.set(-0.2, 0, -0.2); weapon.rotation.set(0.2, 0, 0);
  };
  return { parts: { eb, head, ears, trunk, tusks, legs, tail, rider: r, weapon }, rest };
}

function wheel(M: Mats, r: number, scythe: number) {
  const w = group();
  mesh(new THREE.TorusGeometry(r, 0.05, 6, 18), M.darkWood, 0, 0, 0, w).rotation.y = Math.PI / 2;
  mesh(new THREE.TorusGeometry(r + 0.03, 0.025, 4, 18), M.iron, 0, 0, 0, w).rotation.y = Math.PI / 2;
  for (let i = 0; i < 4; i++) mesh(box(0.035, r * 2, 0.05), M.wood, 0, 0, 0, w).rotation.x = (i / 4) * Math.PI;
  const hub = mesh(cyl(0.08, 0.08, 0.16, 8), M.trim, 0, 0, 0, w); hub.rotation.z = Math.PI / 2;
  if (scythe) { const s = mesh(cone(0.05, 0.34, 5), M.iron, scythe * 0.24, 0, 0, w); s.rotation.z = -scythe * Math.PI / 2; }
  return w;
}

function buildChariot(M: Mats, side: Side, body: THREE.Group): Built {
  const cb = group(0, 0.5, 0, body);
  mesh(box(0.95, 0.18, 1.5), M.wood, 0, 0, 0, cb);
  const wheels = [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => {
    const w = wheel(M, 0.36, sx); w.position.set(sx * 0.6, -0.08, sz * 0.48); cb.add(w); return w;
  });
  for (const sz of [-1, 1]) mesh(cyl(0.04, 0.04, 1.2, 6), M.darkWood, 0, -0.08, sz * 0.48, cb).rotation.z = Math.PI / 2;
  // Armoured cabin
  mesh(box(0.98, 0.52, 0.08), M.armor, 0, 0.35, 0.72, cb);
  mesh(sph(0.13, 8, 6).scale(1, 1, 0.5), M.trim, 0, 0.36, 0.77, cb);
  for (const sx of [-1, 1]) {
    mesh(box(0.08, 0.42, 1.36), M.armor, sx * 0.45, 0.3, 0.03, cb);
    mesh(box(0.1, 0.05, 1.4), M.trim, sx * 0.45, 0.53, 0.03, cb);
    for (let i = 0; i < 3; i++) mesh(sph(0.05, 5, 4), M.trim, sx * 0.5, 0.3, -0.4 + i * 0.42, cb);
  }
  // Ram with a bronze beast head
  mesh(cyl(0.09, 0.11, 0.8, 8), M.darkWood, 0, 0.08, 1.05, cb).rotation.x = Math.PI / 2;
  const rh = mesh(cone(0.19, 0.4, 6), M.bronze, 0, 0.08, 1.6, cb); rh.rotation.x = Math.PI / 2;
  for (const sx of [-1, 1]) {
    mesh(cone(0.04, 0.26, 5), M.ivory, sx * 0.13, 0.22, 1.46, cb).rotation.set(0.5, 0, -sx * 0.5);
    mesh(sph(0.035, 5, 4), M.glow, sx * 0.09, 0.16, 1.56, cb);
  }
  // Parasol and banner
  mesh(cyl(0.022, 0.022, 1.5, 5), M.trim, 0, 0.85, -0.42, cb);
  mesh(cone(0.62, 0.2, 10), M.cloth, 0, 1.68, -0.42, cb);
  mesh(cyl(0.63, 0.63, 0.03, 10), M.trim, 0, 1.58, -0.42, cb);
  mesh(cyl(0.018, 0.018, 1.3, 5), M.trim, 0.4, 0.75, -0.7, cb);
  const flag = mesh(new THREE.PlaneGeometry(0.7, 0.42, 8, 3).translate(0.35, 0, 0), clothMat(TEAM[side].main, null, 'flag'), 0.4, 1.18, -0.7, cb);
  flag.rotation.y = Math.PI / 2;
  const r = human(M, 'plain'); r.g.scale.setScalar(0.85); r.g.position.set(0, 0.09, 0.1); cb.add(r.g);
  const weapon = polearm(M, 'ge', 1.8); weapon.position.y = -0.45; r.armR.add(weapon);
  const rest = () => {
    cb.rotation.set(0, 0, 0); cb.position.set(0, 0.5, 0);
    r.armR.rotation.set(-0.2, 0, -0.2); weapon.rotation.set(0.2, 0, 0); r.armL.rotation.set(-0.9, 0, 0.2); r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { cb, wheels, rider: r, weapon, flag }, rest };
}

function buildCannon(M: Mats, _s: Side, body: THREE.Group): Built {
  const cb = group(0, 0, 0, body);
  const wheels = [-1, 1].map((sx) => { const w = wheel(M, 0.38, 0); w.position.set(sx * 0.48, 0.42, 0.05); cb.add(w); return w; });
  mesh(cyl(0.045, 0.045, 1.0, 6), M.darkWood, 0, 0.42, 0.05, cb).rotation.z = Math.PI / 2;
  const tr = mesh(box(0.2, 0.13, 1.15), M.wood, 0, 0.26, -0.5, cb); tr.rotation.x = -0.3;
  for (const sx of [-1, 1]) mesh(box(0.08, 0.3, 0.55), M.wood, sx * 0.22, 0.55, 0.05, cb);
  const barrel = group(0, 0.68, 0.05, cb);
  const tube = mesh(cyl(0.13, 0.2, 1.4, 10), M.bronze, 0, 0, 0.3, barrel); tube.rotation.x = Math.PI / 2;
  for (const z of [-0.25, 0.2, 0.62]) mesh(cyl(0.215 - (z + 0.4) * 0.05, 0.215 - (z + 0.4) * 0.05, 0.07, 10), M.trim, 0, 0, z, barrel).rotation.x = Math.PI / 2;
  mesh(cyl(0.18, 0.15, 0.16, 10), M.trim, 0, 0, 0.98, barrel).rotation.x = Math.PI / 2;
  mesh(cyl(0.1, 0.1, 0.02, 10), M.black, 0, 0, 1.065, barrel).rotation.x = Math.PI / 2;
  mesh(sph(0.13, 8, 6), M.bronze, 0, 0, -0.44, barrel);
  mesh(sph(0.04, 5, 4), M.glow, 0, 0.2, -0.3, barrel);
  const muzzle = group(0, 0, 1.1, barrel);
  const r = human(M, 'plain', { pads: false }); r.g.scale.setScalar(0.84); r.g.position.set(-0.72, 0, -0.42); cb.add(r.g);
  const weapon = group(0, -0.45, 0, r.armR);
  mesh(cyl(0.02, 0.02, 0.6, 5), M.darkWood, 0, 0.2, 0, weapon);
  const torch = mesh(sph(0.06, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffa040 }), 0, 0.52, 0, weapon); torch.castShadow = false;
  for (const [x, z] of [[0.62, -0.5], [0.78, -0.4], [0.68, -0.33]]) mesh(sph(0.1, 7, 5), M.black, x, 0.1, z, cb);
  mesh(sph(0.1, 7, 5), M.black, 0.69, 0.25, -0.41, cb);
  const rest = () => {
    cb.rotation.set(0, 0, 0); cb.position.set(0, 0, 0); barrel.rotation.set(-0.08, 0, 0);
    r.armR.rotation.set(-0.5, 0, -0.1); weapon.rotation.set(0.3, 0, 0); r.armL.rotation.set(0, 0, 0.1);
    r.legL.rotation.set(0, 0, 0); r.legR.rotation.set(0, 0, 0); r.torso.rotation.set(0, 0, 0);
  };
  return { parts: { cb, wheels, barrel, muzzle, rider: r, weapon, torch }, rest };
}

const BUILD: Record<PType, (M: Mats, s: Side, body: THREE.Group) => Built> = {
  K: buildKing, A: buildAdvisor, B: buildElephant, N: buildHorse, R: buildChariot, C: buildCannon, P: buildPawn,
};
/** Authored replacements, used when the model loaded and fine models are switched on. */
const FINE: Record<PType, { asset: string; build: (M: Mats, s: Side, body: THREE.Group) => Built }> = {
  K: { asset: 'king', build: fineKing }, A: { asset: 'advisor', build: fineAdvisor }, B: { asset: 'elephant', build: fineElephant },
  N: { asset: 'horse', build: fineHorse }, R: { asset: 'chariot', build: fineChariot }, C: { asset: 'cannon', build: fineCannon }, P: { asset: 'pawn', build: finePawn },
};
export const fineModels = { on: true };

// ---------- Unit ----------
const badgeTex = new Map<string, THREE.Texture>();
const ringGeo = new THREE.RingGeometry(0.6, 0.74, 40).rotateX(-Math.PI / 2);
ringGeo.userData.shared = true;
const tmp = new THREE.Vector3();

export class Unit {
  piece: Piece;
  root = new THREE.Group(); // position + heading on the board
  body = new THREE.Group(); // local tilt / bob / hop offsets
  parts: any;
  rest: () => void;
  skeleton?: THREE.Skeleton;
  height: number;
  badge: THREE.Sprite;
  ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  pick: THREE.Mesh;
  sq = 0;
  busy = false;
  dead = false;
  seed = rand(100);
  /** Detail level of the authored model this unit was built from (none when procedural). */
  private models?: Detail;

  constructor(piece: Piece, sq: number, scene: THREE.Scene) {
    this.piece = piece;
    const M = mats(piece.side), T = TEAM[piece.side];
    this.root.add(this.body);
    const fine = FINE[piece.type], authored = fineModels.on && !!model(fine.asset);
    if (authored) this.models = useModels();
    const b = (authored ? fine.build : BUILD[piece.type])(M, piece.side, this.body);
    this.parts = b.parts; this.rest = b.rest; this.skeleton = b.skeleton; this.rest();
    this.height = HEIGHT[piece.type];

    const key = piece.side + piece.type;
    if (!badgeTex.has(key)) badgeTex.set(key, glyphTexture(GLYPH[piece.side][piece.type], piece.side === 'r'
      ? { round: true, bg: '#8e140e', fg: '#ffe9b0', border: '#f0c060', size: 150 }
      : { round: true, bg: '#101823', fg: '#a8f2ff', border: '#63bfae', size: 150 }));
    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTex.get(key)!, depthWrite: false, fog: false }));
    this.badge.scale.setScalar(0.66); this.badge.position.y = this.height + 0.42; this.badge.renderOrder = 20;
    this.root.add(this.badge);

    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: T.glow, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring.position.y = 0.035; this.ring.renderOrder = 3;
    this.root.add(this.ring);

    this.pick = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, this.height, 8).translate(0, this.height / 2, 0));
    this.pick.visible = false; this.pick.userData.unit = this;
    this.root.add(this.pick);

    this.place(sq);
    scene.add(this.root);
  }

  get homeYaw() { return this.piece.side === 'r' ? Math.PI : 0; }

  place(sq: number) {
    this.sq = sq;
    sqPos(sq, this.root.position);
    this.root.rotation.set(0, this.homeYaw, 0);
  }

  setXZ(x: number, z: number) { this.root.position.set(x, groundHeight(x, z), z); }

  /** World position of a part (e.g. weapon tip, muzzle). */
  partPos(o: THREE.Object3D, out = new THREE.Vector3()) { return o.getWorldPosition(out); }

  /** Ambient idle motion; pose-affecting parts are only touched when not busy. */
  idle(t: number, dt: number) {
    if (this.dead) return;
    const p = this.parts, s = this.seed, ty = this.piece.type;
    if (ty === 'C' && Math.random() < dt * 14) fx.fire(this.partPos(p.torch, tmp), 1, 0.32);
    if (p.tailChain && dt > 0) this.swishTail(t, dt);
    if (this.busy) return;
    const br = Math.sin(t * 1.8 + s);
    switch (ty) {
      case 'K': p.wind.value = 0.16 + 0.06 * Math.sin(t * 0.7 + s); p.torso.rotation.x = br * 0.012; p.head.rotation.y = Math.sin(t * 0.5 + s) * 0.25; break;
      case 'A': case 'P': p.torso.rotation.x = br * 0.02; p.head.rotation.y = Math.sin(t * 0.6 + s) * 0.3; break;
      case 'N':
        p.neck.rotation.x = Math.sin(t * 1.1 + s) * 0.07 + Math.max(0, Math.sin(t * 0.37 + s) - 0.9) * 3;
        p.tail.rotation.z = Math.sin(t * 2.6 + s) * 0.3;
        p.legs[0].rotation.x = -Math.max(0, Math.sin(t * 0.5 + s) - 0.92) * 9; break;
      case 'B':
        p.ears[0].rotation.y = Math.sin(t * 2.1 + s) * 0.28 - 0.1; p.ears[1].rotation.y = -Math.sin(t * 2.1 + s + 0.4) * 0.28 + 0.1;
        p.trunk.forEach((g: THREE.Group, i: number) => { g.rotation.z = Math.sin(t * 1.2 + s + i * 0.6) * 0.07; });
        p.head.rotation.x = Math.sin(t * 0.8 + s) * 0.03; p.tail.rotation.z = Math.sin(t * 3 + s) * 0.4; break;
      case 'R': p.rider.torso.rotation.x = br * 0.02; break;
      case 'C': p.rider.armR.rotation.x = -0.5 + br * 0.05; break;
    }
  }

  /** Follow-through for a segmented tail: each bone chases the one above it, so swings ripple to the tip. */
  private swishTail(t: number, dt: number) {
    const p = this.parts, pos = this.root.position, k = 1 - Math.exp(-dt * 9);
    // Speed over the ground and through the air streams the tail out behind.
    const y = pos.y + this.body.position.y;
    if (this.lastPos.lengthSq() === 0) this.lastPos.set(pos.x, y, pos.z); // first frame: no phantom gust
    const speed = Math.min(14, Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z, y - this.lastPos.y) / dt);
    this.lastPos.set(pos.x, y, pos.z);
    this.wind += (speed - this.wind) * (1 - Math.exp(-dt * 6));
    let leadX = p.tail.rotation.x + this.wind * 0.035, leadZ = p.tail.rotation.z;
    p.tailChain.forEach((b: THREE.Bone, i: number) => {
      const sway = Math.sin(t * 2.3 + this.seed - i * 0.9) * 0.07 * (i + 1);
      b.rotation.x += (leadX * 0.75 - b.rotation.x) * k; b.rotation.z += (leadZ * 0.9 + sway - b.rotation.z) * k;
      leadX = b.rotation.x; leadZ = b.rotation.z;
    });
  }
  private lastPos = new THREE.Vector3();
  private wind = 0;

  dispose() {
    if (this.models) { dropModels(this.models); this.models = undefined; }
    this.dead = true; disposeTree(this.root); this.pick.geometry.dispose(); this.ring.material.dispose(); (this.badge.material as THREE.Material).dispose();
  }
}

export type { Human };
