// Lighter variants of the authored models for the lower quality tiers.
//   node tools/blender/lod.mjs [public/models] [names...]
// Reads <name>.glb (written by build.py) and writes <name>_mid.glb and <name>_lo.glb next to it.
// Simplification only re-indexes the original vertices, so UVs, skin weights and the baked
// <name>_ao.png stay valid; tiny loose bits (rivets, studs) are pruned outright.
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier as S } from 'meshoptimizer';

const DIR = path.resolve(process.argv[2] ?? 'public/models');
const NAMES = process.argv.slice(3).length ? process.argv.slice(3) : ['king', 'advisor', 'pawn', 'horse', 'elephant', 'chariot', 'cannon'];
/** Share of triangles kept and the error allowed (relative to the part's size) per variant. */
const LEVELS = { mid: { ratio: 0.5, error: 0.01 }, lo: { ratio: 0.2, error: 0.04 } };

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
  const b = fs.readFileSync(file), jl = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + jl).toString());
  const bin = b.subarray(20 + jl + 8, 20 + jl + 8 + b.readUInt32LE(20 + jl));
  const read = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], T = COMP[a.componentType], n = a.count * SIZE[a.type];
    if (v.byteStride && v.byteStride !== T.BYTES_PER_ELEMENT * SIZE[a.type]) throw new Error('interleaved accessors are not supported');
    const off = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT));
  };
  return { json, read };
}

function writeGlb(file, json, arrays) {
  // One tightly packed buffer view per accessor, 4-byte aligned.
  const views = [], accessors = [], chunks = [];
  let off = 0;
  arrays.forEach(({ data, acc, target }) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), pad = (4 - (bytes.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, ...(target ? { target } : {}) });
    accessors.push({ ...acc, bufferView: views.length - 1, byteOffset: undefined });
    chunks.push(bytes, Buffer.alloc(pad)); off += bytes.length + pad;
  });
  const out = { ...json, accessors, bufferViews: views, buffers: [{ byteLength: off }] };
  let js = Buffer.from(JSON.stringify(out));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  fs.writeFileSync(file, Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
}

function lod(name, level) {
  const { json, read } = readGlb(path.join(DIR, name + '.glb')), { ratio, error } = LEVELS[level];
  const arrays = [], remapAcc = new Map();
  const push = (data, acc, target) => { arrays.push({ data, acc, target }); return arrays.length - 1; };
  // Accessors that are not mesh data (inverse bind matrices) are copied as they are.
  const meshAcc = new Set(json.meshes.flatMap((m) => m.primitives.flatMap((p) => [...Object.values(p.attributes), p.indices])));
  json.accessors.forEach((a, i) => { if (!meshAcc.has(i)) remapAcc.set(i, push(read(i), a)); });
  let before = 0, after = 0;
  const meshes = json.meshes.map((m) => ({
    ...m,
    primitives: m.primitives.map((p) => {
      const pos = read(p.attributes.POSITION), idx = Uint32Array.from(read(p.indices));
      // The dominant joint rides along as an attribute so edges do not collapse across a skin seam.
      const joints = read(p.attributes.JOINTS_0), weights = read(p.attributes.WEIGHTS_0), uv = read(p.attributes.TEXCOORD_0);
      const nv = pos.length / 3, attr = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        let best = 0; for (let k = 1; k < 4; k++) if (weights[v * 4 + k] > weights[v * 4 + best]) best = k;
        attr[v * 3] = uv[v * 2]; attr[v * 3 + 1] = uv[v * 2 + 1]; attr[v * 3 + 2] = joints[v * 4 + best];
      }
      const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
      let [out] = S.simplifyWithAttributes(idx, pos, 3, attr, 3, [0.4, 0.4, 2], null, target, error, ['Prune']);
      if (out.length < 3) out = idx; // never drop a whole part
      before += idx.length / 3; after += out.length / 3;
      // Keep only the vertices still referenced.
      const map = new Int32Array(nv).fill(-1), keep = [];
      const ni = out.map((v) => (map[v] < 0 ? ((map[v] = keep.length), keep.push(v), map[v]) : map[v]));
      const attributes = {};
      for (const [k, ai] of Object.entries(p.attributes)) {
        const a = json.accessors[ai], src = read(ai), n = SIZE[a.type], dst = new src.constructor(keep.length * n);
        keep.forEach((v, j) => { for (let c = 0; c < n; c++) dst[j * n + c] = src[v * n + c]; });
        const acc = { ...a, count: keep.length };
        if (k === 'POSITION') {
          const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
          for (let j = 0; j < keep.length; j++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], dst[j * 3 + c]); mx[c] = Math.max(mx[c], dst[j * 3 + c]); }
          acc.min = mn; acc.max = mx;
        }
        attributes[k] = push(dst, acc, 34962);
      }
      const big = keep.length > 65535, ind = big ? Uint32Array.from(ni) : Uint16Array.from(ni);
      const indices = push(ind, { componentType: big ? 5125 : 5123, count: ind.length, type: 'SCALAR' }, 34963);
      return { ...p, attributes, indices };
    }),
  }));
  const skins = json.skins?.map((s) => ({ ...s, inverseBindMatrices: s.inverseBindMatrices === undefined ? undefined : remapAcc.get(s.inverseBindMatrices) }));
  writeGlb(path.join(DIR, `${name}_${level}.glb`), { ...json, meshes, skins }, arrays);
  console.log(`${name}_${level}: ${before} -> ${after} tris (${((after / before) * 100).toFixed(0)}%)`);
}

await S.ready;
for (const n of NAMES) for (const l of Object.keys(LEVELS)) lod(n, l);
