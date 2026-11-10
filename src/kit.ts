// Small shared helpers for building procedural meshes and materials.
import * as THREE from 'three';

export const FONT = '"STKaiti","Kaiti SC","KaiTi","BiauKai","Songti SC","SimSun",serif';
export const timeU = { value: 0 }; // shared shader time uniform

export function std(color: THREE.ColorRepresentation, o: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, flatShading: true, ...o });
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent?.add(m);
  return m;
}

export function group(x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent?.add(g);
  return g;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
export const sph = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
export const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);

/**
 * Cloth material animated in the vertex shader.
 * mode 'flag': plane pinned along uv.x = 0, waves grow towards the free edge.
 * mode 'cape': plane pinned along uv.y = 1, hangs down and billows backwards (-z).
 */
export function clothMat(color: THREE.ColorRepresentation, map: THREE.Texture | null, mode: 'flag' | 'cape', windU?: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ color, map, side: THREE.DoubleSide, roughness: 0.9 });
  const wind = windU ?? { value: 1 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU; sh.uniforms.uWind = wind;
    const body = mode === 'flag'
      ? `float ph = modelMatrix[3].x * 1.7 + modelMatrix[3].z * 1.3;
         float w = uv.x;
         transformed.z += sin(uv.x * 7.0 - uTime * 5.0 + ph + uv.y * 2.0) * 0.16 * w * uWind;
         transformed.y += sin(uv.x * 4.0 - uTime * 3.6 + ph) * 0.06 * w;`
      : `float w = 1.0 - uv.y;
         transformed.z -= (0.12 + 0.55 * uWind) * w * w + sin(uv.y * 6.0 + uTime * (3.0 + 5.0 * uWind) + uv.x * 3.0) * 0.07 * w * (0.5 + uWind);
         transformed.y += 0.25 * uWind * w * w;`;
    sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + body);
  };
  return m;
}

/** Canvas texture with a single calligraphic glyph (optionally on a filled background). */
export function glyphTexture(text: string, o: { size?: number; fg?: string; bg?: string; border?: string; round?: boolean; w?: number; h?: number; glow?: string } = {}) {
  const w = o.w ?? 256, h = o.h ?? 256;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (o.bg) {
    g.fillStyle = o.bg;
    if (o.round) { g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2); g.fill(); }
    else g.fillRect(0, 0, w, h);
  }
  if (o.border) {
    g.strokeStyle = o.border; g.lineWidth = w * 0.045;
    if (o.round) {
      g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 10, 0, Math.PI * 2); g.stroke();
      g.lineWidth = w * 0.015; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 28, 0, Math.PI * 2); g.stroke();
    } else g.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
  }
  g.font = `bold ${o.size ?? Math.floor(Math.min(w, h) * 0.62)}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = w * 0.08; }
  g.fillStyle = o.fg ?? '#fff';
  const chars = [...text];
  if (h > w * 1.3 && chars.length > 1) chars.forEach((ch, i) => g.fillText(ch, w / 2, (h * (i + 0.5)) / chars.length));
  else g.fillText(text, w / 2, h / 2 + h * 0.03);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export const TEAM = {
  r: { main: 0xb3221c, dark: 0x5e0f0c, trim: 0xe2b04a, glow: 0xffa030, css: '#ff5a3c', name: '红方' },
  b: { main: 0x222c3c, dark: 0x0e1218, trim: 0x63bfae, glow: 0x35d6ff, css: '#4fd8f0', name: '黑方' },
} as const;
