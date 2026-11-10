// Authored models (built by tools/blender/build.py) and the glue that makes them drivable by the
// existing choreography: the glb supplies meshes, skin weights and joint positions, and the
// skeleton is rebuilt here with identity rest rotations so `bone.rotation.x` means the same as
// it does on the procedural rigs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Detail } from './quality';

/** One drawable piece. `attach` is the bone it is parented to, so it travels with that bone when thrown. */
interface Prim { geometry: THREE.BufferGeometry; material: string; attach: string }
export interface ModelAsset {
  prims: Prim[];
  /**
   * Lighter detail levels draw each bone's parts as one mesh: `palette` lists the materials and the
   * geometry's `aMat` attribute indexes into it, so a whole part costs one draw call.
   */
  merged?: { geometry: THREE.BufferGeometry; attach: string }[];
  palette?: string[];
  /** Joints in skin order: name, parent name and bind position in model space. */
  joints: { name: string; parent: string | null; pos: THREE.Vector3 }[];
  inverses: THREE.Matrix4[];
  /** Baked detail: R ambient occlusion, G edge wear, B mud. */
  baked: THREE.Texture;
}

export const MODEL_NAMES = ['king', 'advisor', 'pawn', 'horse', 'elephant', 'chariot', 'cannon'];
const assets = new Map<string, ModelAsset>(); // "name:detail"
const bakedTex = new Map<string, Promise<THREE.Texture>>(); // the detail map is shared by every level of a model
let detail: Detail = 'full';
export const model = (name: string) => assets.get(`${name}:${detail}`);
const FILE: Record<Detail, string> = { full: '', mid: '_mid', lo: '_lo' };

async function loadModel(name: string, d: Detail) {
  const base = import.meta.env.BASE_URL + 'models/';
  const tex = bakedTex.get(name) ?? new THREE.TextureLoader().loadAsync(base + name + '_ao.png').then((t) => {
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; return t;
  });
  bakedTex.set(name, tex);
  const [gltf, baked] = await Promise.all([new GLTFLoader().loadAsync(base + name + FILE[d] + '.glb'), tex]);
  gltf.scene.updateMatrixWorld(true);
  const prims: Prim[] = [];
  let skeleton: THREE.Skeleton | null = null;
  gltf.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    skeleton ??= m.skeleton;
    m.geometry.userData.shared = true; // one copy on the GPU for every unit
    const label = m.parent && m.parent.name.includes('__') ? m.parent.name : m.name; // "Part__bone"
    prims.push({ geometry: m.geometry, material: (m.material as THREE.Material).name, attach: label.split('__')[1] });
  });
  if (!skeleton) throw new Error(`${name}.glb has no skinned mesh`);
  const joints = (skeleton as THREE.Skeleton).bones.map((b) => ({ name: b.name, parent: (b.parent as THREE.Bone | null)?.isBone ? b.parent!.name : null, pos: b.getWorldPosition(new THREE.Vector3()) }));
  const inverses = joints.map((j) => new THREE.Matrix4().makeTranslation(-j.pos.x, -j.pos.y, -j.pos.z));
  const a: ModelAsset = { prims, joints, inverses, baked };
  if (d !== 'full') merge(a);
  assets.set(`${name}:${d}`, a);
}

/** Fold every part riding on the same bone into one geometry, tagging each vertex with its material. */
function merge(a: ModelAsset) {
  const palette = [...new Set(a.prims.map((p) => p.material))];
  const byBone = new Map<string, THREE.BufferGeometry[]>();
  for (const p of a.prims) {
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) g.setAttribute(k, p.geometry.getAttribute(k));
    g.setIndex(p.geometry.index);
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(palette.indexOf(p.material)), 1));
    byBone.set(p.attach, [...(byBone.get(p.attach) ?? []), g]);
  }
  a.merged = [...byBone].map(([attach, gs]) => {
    const geometry = mergeGeometries(gs)!;
    geometry.userData.shared = true;
    return { geometry, attach };
  });
  a.palette = palette;
}

/** Load every authored model at this detail level and make it the one new units use. Failures are tolerated: that unit falls back to its procedural build. */
export async function loadModels(d: Detail = detail) {
  await Promise.all(MODEL_NAMES.map((n) => assets.has(`${n}:${d}`) ? null : loadModel(n, d).catch((e) => console.warn(`model "${n}" (${d}) not loaded, using the procedural fallback:`, e))));
  const old = detail;
  detail = d;
  if (old !== d && !users[old]) release(old);
}

// Units count themselves in and out, so a level's GPU buffers are freed once its last unit is gone.
const users: Record<Detail, number> = { full: 0, mid: 0, lo: 0 };
/** A unit is being built from the current level; returns the level so it can hand it back. */
export function useModels() { users[detail]++; return detail; }
export function dropModels(d: Detail) { if (!--users[d] && d !== detail) release(d); }
/** Free a level's GPU copies. Parsed data stays in memory for a quick switch back (three re-uploads it if drawn again). */
function release(d: Detail) {
  for (const [k, a] of assets) if (k.endsWith(':' + d)) for (const g of [...a.prims.map((p) => p.geometry), ...(a.merged ?? []).map((m) => m.geometry)]) g.dispose();
}

const IDENTITY = new THREE.Matrix4();
/** 0 at the opening, 1 late in the battle: armies get dustier and more battered as the game goes on. */
export const grime = { value: 0 };
const skinned = new Map<string, THREE.Material>();
// How strongly each material shows edge wear and mud. Metals scuff bright, cloth and wood fade, living things do neither.
const WEAR: Record<string, number> = { armor: 0.6, trim: 0.5, iron: 0.55, bronze: 0.55, cloth: 0.35, clothDark: 0.3, leather: 0.4, wood: 0.4, darkWood: 0.4 };
const NO_MUD = new Set(['glow', 'skin']);
/** Shader lines that apply the baked detail map; `wear` and `mud` are GLSL expressions. */
const detailGlsl = (wear: string, mud: string) => /* glsl */ `
        vec3 bk = texture2D(map, vMapUv).rgb;
        diffuseColor.rgb *= mix(0.4, 1.0, bk.r);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 2.6 + 0.16, min(1.0, bk.g * (2.2 + 2.0 * uGrime)) * ${wear} * 1.35);
        float dirt = min(1.0, bk.b * (2.4 + 3.0 * uGrime) + uGrime * 0.22 * (1.0 - bk.r * 0.5));   // dust climbs the legs, then settles everywhere
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.18, 0.12), dirt * ${mud});`;
/** A copy of a team material that reads the baked detail map. */
function detailed(src: THREE.MeshStandardMaterial, name: string, tex: THREE.Texture, key: string) {
  let m = skinned.get(key);
  if (!m) {
    const c = src.clone(), wear = (WEAR[name] ?? 0).toFixed(2), mud = NO_MUD.has(name) ? '0.0' : '0.85';
    c.map = tex; c.aoMap = tex; c.aoMapIntensity = 1;
    c.customProgramCacheKey = () => `baked-${wear}-${mud}`;
    c.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', detailGlsl(wear, mud)).replace('void main() {', 'uniform float uGrime;\nvoid main() {');
      sh.uniforms.uGrime = grime;
    };
    skinned.set(key, (m = c));
  }
  return m;
}

/** One material for a merged model: colour, roughness, metalness, glow, wear and mud come from a per-vertex palette index. */
function paletted(a: ModelAsset, materials: (name: string) => THREE.MeshStandardMaterial, key: string) {
  const k = `${key}:${a.palette!.join()}`;
  let m = skinned.get(k);
  if (!m) {
    const names = a.palette!, n = names.length, col: THREE.Color[] = [], emi: THREE.Color[] = [], pbr: THREE.Vector4[] = [];
    for (const name of names) {
      const s = materials(name);
      col.push(s.color.clone()); emi.push(s.emissive.clone().multiplyScalar(s.emissiveIntensity));
      pbr.push(new THREE.Vector4(s.roughness, s.metalness, WEAR[name] ?? 0, NO_MUD.has(name) ? 0 : 0.85));
    }
    const c = new THREE.MeshStandardMaterial({ flatShading: true, map: a.baked, aoMap: a.baked, aoMapIntensity: 1 });
    c.customProgramCacheKey = () => `palette-${n}`;
    c.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uGrime: grime, uCol: { value: col }, uEmi: { value: emi }, uPbr: { value: pbr } });
      sh.vertexShader = 'attribute float aMat;\nvarying float vMat;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;');
      sh.fragmentShader = `uniform float uGrime; uniform vec3 uCol[${n}], uEmi[${n}]; uniform vec4 uPbr[${n}]; varying float vMat;\n` + sh.fragmentShader
        .replace('#include <map_fragment>', 'int mi = int(vMat + 0.5); vec4 pb = uPbr[mi]; diffuseColor.rgb = uCol[mi]; totalEmissiveRadiance = uEmi[mi];' + detailGlsl('pb.z', 'pb.w'))
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pb.x;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = pb.y;');
    };
    skinned.set(k, (m = c));
  }
  return m;
}

/** Instantiate a model under `parent`. Returns its bones by name and the skeleton that drives it. */
export function instantiate(a: ModelAsset, parent: THREE.Object3D, materials: (name: string) => THREE.MeshStandardMaterial, key: string) {
  const bones: Record<string, THREE.Bone> = {}, list: THREE.Bone[] = [], at = new Map(a.joints.map((j) => [j.name, j.pos]));
  for (const j of a.joints) {
    const b = new THREE.Bone(); b.name = j.name;
    b.position.copy(j.pos); if (j.parent) b.position.sub(at.get(j.parent)!);
    (j.parent ? bones[j.parent] : parent).add(b);
    bones[j.name] = b; list.push(b);
  }
  const skeleton = new THREE.Skeleton(list, a.inverses.map((m) => m.clone()));
  const parts = a.merged
    ? a.merged.map((p) => ({ geometry: p.geometry, attach: p.attach, mat: paletted(a, materials, key) }))
    : a.prims.map((p) => ({ geometry: p.geometry, attach: p.attach, mat: detailed(materials(p.material), p.material, a.baked, `${key}:${p.material}`) }));
  for (const p of parts) {
    const mesh = new THREE.SkinnedMesh(p.geometry, p.mat);
    mesh.bind(skeleton, IDENTITY);
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
    const bone = bones[p.attach];
    bone.add(mesh);
    // A free-standing, unskinned copy of everything riding on this bone (for a thrown weapon).
    const origin = at.get(p.attach)!;
    (bone.userData.pieces ??= [] as THREE.Mesh[]).push(() => { const m = new THREE.Mesh(p.geometry, p.mat); m.position.copy(origin).negate(); m.castShadow = true; return m; });
    bone.userData.copy = () => { const g = new THREE.Group(); for (const f of bone.userData.pieces) g.add(f()); return g; };
  }
  return { bones, skeleton };
}
