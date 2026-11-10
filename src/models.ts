// Authored models (built by tools/blender/build.py) and the glue that makes them drivable by the
// existing choreography: the glb supplies meshes, skin weights and joint positions, and the
// skeleton is rebuilt here with identity rest rotations so `bone.rotation.x` means the same as
// it does on the procedural rigs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** One drawable piece. `attach` is the bone it is parented to, so it travels with that bone when thrown. */
interface Prim { geometry: THREE.BufferGeometry; material: string; attach: string }
export interface ModelAsset {
  prims: Prim[];
  /** Joints in skin order: name, parent name and bind position in model space. */
  joints: { name: string; parent: string | null; pos: THREE.Vector3 }[];
  inverses: THREE.Matrix4[];
  /** Baked detail: R ambient occlusion, G edge wear, B mud. */
  baked: THREE.Texture;
}

export const MODEL_NAMES = ['king', 'advisor', 'pawn', 'horse', 'elephant', 'chariot', 'cannon'];
const assets = new Map<string, ModelAsset>();
export const model = (name: string) => assets.get(name);

async function loadModel(name: string) {
  const base = import.meta.env.BASE_URL + 'models/';
  const [gltf, baked] = await Promise.all([new GLTFLoader().loadAsync(base + name + '.glb'), new THREE.TextureLoader().loadAsync(base + name + '_ao.png')]);
  baked.flipY = false; baked.colorSpace = THREE.NoColorSpace; baked.anisotropy = 4;
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
  assets.set(name, { prims, joints, inverses, baked });
}

/** Load every authored model. Failures are tolerated: that unit falls back to its procedural build. */
export async function loadModels() {
  await Promise.all(MODEL_NAMES.map((n) => loadModel(n).catch((e) => console.warn(`model "${n}" not loaded, using the procedural fallback:`, e))));
}

const IDENTITY = new THREE.Matrix4();
/** 0 at the opening, 1 late in the battle: armies get dustier and more battered as the game goes on. */
export const grime = { value: 0 };
const skinned = new Map<string, THREE.Material>();
// How strongly each material shows edge wear and mud. Metals scuff bright, cloth and wood fade, living things do neither.
const WEAR: Record<string, number> = { armor: 0.6, trim: 0.5, iron: 0.55, bronze: 0.55, cloth: 0.35, clothDark: 0.3, leather: 0.4, wood: 0.4, darkWood: 0.4 };
const NO_MUD = new Set(['glow', 'skin']);
/** A copy of a team material that reads the baked detail map. */
function detailed(src: THREE.MeshStandardMaterial, name: string, tex: THREE.Texture, key: string) {
  let m = skinned.get(key);
  if (!m) {
    const c = src.clone(), wear = (WEAR[name] ?? 0).toFixed(2), mud = NO_MUD.has(name) ? '0.0' : '0.85';
    c.map = tex; c.aoMap = tex; c.aoMapIntensity = 1;
    c.customProgramCacheKey = () => `baked-${wear}-${mud}`;
    c.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', /* glsl */ `
        vec3 bk = texture2D(map, vMapUv).rgb;
        diffuseColor.rgb *= mix(0.4, 1.0, bk.r);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 2.6 + 0.16, min(1.0, bk.g * (2.2 + 2.0 * uGrime)) * ${wear} * 1.35);
        float dirt = min(1.0, bk.b * (2.4 + 3.0 * uGrime) + uGrime * 0.22 * (1.0 - bk.r * 0.5));   // dust climbs the legs, then settles everywhere
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.18, 0.12), dirt * ${mud});`).replace('void main() {', 'uniform float uGrime;\nvoid main() {');
      sh.uniforms.uGrime = grime;
    };
    skinned.set(key, (m = c));
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
  for (const p of a.prims) {
    const mat = detailed(materials(p.material), p.material, a.baked, `${key}:${p.material}`);
    const mesh = new THREE.SkinnedMesh(p.geometry, mat);
    mesh.bind(skeleton, IDENTITY);
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
    const bone = bones[p.attach];
    bone.add(mesh);
    // A free-standing, unskinned copy of everything riding on this bone (for a thrown weapon).
    const origin = at.get(p.attach)!;
    (bone.userData.pieces ??= [] as THREE.Mesh[]).push(() => { const m = new THREE.Mesh(p.geometry, mat); m.position.copy(origin).negate(); m.castShadow = true; return m; });
    bone.userData.copy = () => { const g = new THREE.Group(); for (const f of bone.userData.pieces) g.add(f()); return g; };
  }
  return { bones, skeleton };
}
