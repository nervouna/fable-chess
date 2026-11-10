// The river 楚河漢界: a stylised water shader, ripple rings and wakes, and the splashes of units that ford it.
import * as THREE from 'three';
import { BANK, BRIDGE_X, clock, inWater, riverCenter, WATER_Y } from './core';
import { fx } from './fx';
import { sfx } from './audio';
import { timeU } from './kit';
import { quality, TIERS, type Settings, type Tier } from './quality';

/** Ring buffer size for ripples per tier (each is a uniform the water shader loops over). */
const RIPPLES = { high: 24, mid: 16, low: 10 } as const;
const MAX_RIP = 24, WADERS = 4;
/** The baked depth map spans x in [-SPAN, SPAN] and HALF either side of the river's centre line. */
const SPAN = 160, HALF = 10, DW = 512, DH = 48;

const GLSL = /* glsl */ `
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
// Value noise with its analytic gradient: (value, d/dx, d/dy).
vec3 noised(vec2 p){
  vec2 i=floor(p), f=fract(p), u=f*f*(3.0-2.0*f), du=6.0*f*(1.0-f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1)), k=a-b-c+d;
  return vec3(a+(b-a)*u.x+(c-a)*u.y+k*u.x*u.y, du*(vec2(b-a,c-a)+k*u.yx));
}
float rc(float x){ float k=smoothstep(12.0,40.0,abs(x)); return (sin(x*0.045)*9.0+sin(x*0.11+1.3)*2.0)*k; }
uniform sampler2D uDepth;
/** Water depth (negative on land): baked from the terrain along the river, the stone channel between the terraces. */
float depthAt(vec2 p){
  if(abs(p.x)<9.68) return ${BANK.toFixed(2)}-abs(p.y) > 0.0 ? 0.8 : -1.0;
  vec2 uv=vec2((p.x+${SPAN}.0)/${2 * SPAN}.0, (p.y-rc(p.x)+${HALF}.0)/${2 * HALF}.0);
  if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) return 0.4; // ponds off the river: no banks known
  return (texture2D(uDepth,uv).r-0.5)*2.0;
}
/** Distance from p into the water from the nearest bank (negative on land), roughly, from the depth. */
float shore(vec2 p){
  if(abs(p.x)<9.68) return ${BANK.toFixed(2)}-abs(p.y); // the stone terrace walls
  return depthAt(p)*2.2;
}
float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,d.y),0.0); }
// Wave height field in river space (s along the flow, n across it), anisotropic, a few octaves.
vec3 waves(vec2 q, float t){
  vec3 h=noised(q*vec2(0.9,1.7)+vec2(0.0,t*0.05))*vec3(1.0,0.9,1.7);
  h+=noised(q*vec2(2.1,3.4)+vec2(5.2,1.3))*vec3(0.5,1.05,1.7);
#ifdef HQ
  h+=noised(q*vec2(4.7,6.1)+vec2(1.7,8.3))*vec3(0.22,1.03,1.34);
#endif
  return h;
}`;

const VERT = /* glsl */ `
varying vec3 vW;
#include <fog_pars_vertex>
void main(){
  vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
  vec4 mvPosition=viewMatrix*w; gl_Position=projectionMatrix*mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform vec3 uSun, uSunCol, uZen, uMid, uHor, uHorSun;
uniform float uTime, uDay, uStorm, uRain, uFlash;
uniform vec4 uRip[NRIP]; uniform vec4 uWade[${WADERS}];
varying vec3 vW;
#include <fog_pars_fragment>
${GLSL}
vec3 skyBase(vec3 d, vec3 sun){
  float h=max(d.y,0.0); float sd=max(dot(normalize(vec3(d.x,0.0,d.z)), normalize(vec3(sun.x,0.0,sun.z))),0.0);
  vec3 hor=mix(uHor, uHorSun, pow(sd,2.5));
  vec3 col=mix(hor, uMid, smoothstep(0.0,0.3,h));
  return mix(col, uZen, smoothstep(0.12,0.85,h));
}
void main(){
  vec2 p=vW.xz; float t=uTime;
  float sd=shore(p), deep=abs(p.x)<9.68 ? smoothstep(0.0,0.85,sd) : smoothstep(0.0,0.75,depthAt(p));
  float noon=1.0-abs(uDay-0.5)*2.0, calm=(1.0-smoothstep(0.0,0.4,uDay))*(1.0-uStorm);
  // River space: s runs downstream (+x), n across. Two phases of a flow map hide the endless shear.
  vec2 q=vec2(p.x, p.y-rc(p.x));
  float speed=(0.3+0.7*deep)*(0.55+0.9*uStorm), per=3.0, ph0=fract(t/per), ph1=fract(t/per+0.5), w0=1.0-abs(1.0-2.0*ph0);
  vec3 h=mix(waves(q-vec2(speed*ph1*per,0.0)+vec2(3.7,1.9),t), waves(q-vec2(speed*ph0*per,0.0),t), w0);
  float amp=mix(0.09,0.15,noon)*(1.0-0.5*calm)+uStorm*0.32;
  vec2 g=h.yz*amp;
  // Ripple rings (wakes, splashes, falling bodies) and the foam collars of units standing in the water.
  float foam=0.0;
  for(int i=0;i<NRIP;i++){
    vec4 r=uRip[i]; float age=t-r.z; if(age<0.0||age>2.6) continue;
    vec2 d=p-r.xy; float L=length(d)+1e-4, R=0.15+age*(0.75+0.25*r.w), x=(L-R)/(0.07+age*0.05);
    float fade=(1.0-age/2.6); fade*=fade*r.w; float ring=exp(-x*x);
    foam+=ring*fade*0.85; g+=d/L*(-2.0*x*ring)*fade*0.22;
  }
  for(int i=0;i<${WADERS};i++){
    vec4 w=uWade[i]; if(w.w<=0.0) continue;
    vec2 d=p-w.xy; float L=length(d); float x=(L-w.z)/0.09;
    foam+=exp(-x*x)*w.w*(0.7+0.3*sin(L*30.0-t*9.0)); // collar, churning
    float down=max(d.x,0.0); foam+=exp(-abs(d.y)/(0.1+down*0.25))*exp(-down*1.4)*w.w*0.5*step(w.z*0.6,L); // trailing wake
  }
  // Rain: rings opening on the surface.
  if(uRain>0.01){
    for(int k=0;k<2;k++){
      vec2 c=p*2.2+float(k)*vec2(0.37,0.61), id=floor(c), f=fract(c)-0.5-(vec2(hash(id),hash(id+3.1))-0.5)*0.5;
      float ph=fract(t*1.4+hash(id+float(k)*7.0)), L=length(f), x=(L-ph*0.42)/0.03, ring=exp(-x*x)*(1.0-ph)*step(hash(id+11.0),uRain);
      foam+=ring*0.35; g+=f/max(L,1e-3)*ring*(1.0-ph)*0.8;
    }
  }
  // Bridge piers: a foam cushion upstream, a wake streaming off downstream.
  float pf=0.0;
  for(int i=0;i<3;i++) for(int j=0;j<2;j++){
    vec2 c=vec2(float(i-1)*6.0, float(j)*1.0-0.5), l=p-c; float d=sdBox(l,vec2(0.75,0.11));
    pf+=exp(-max(d,0.0)*16.0);
    float dn=max(l.x-0.75,0.0); pf+=exp(-abs(l.y)/(0.04+dn*0.09))*exp(-dn*1.6)*0.8*step(0.0,l.x-0.6);
  }
  vec3 n=normalize(vec3(-g.x,1.0,-g.y));
  vec3 V=normalize(cameraPosition-vW); float ndv=max(dot(n,V),0.0);
  float fres=0.06+0.94*pow(1.0-ndv,4.0);
  vec3 R=reflect(-V,n); R.y=abs(R.y);
  vec3 sky=skyBase(R,uSun);
  // Body colour: teal shallows over a dark channel, lit by the sky so it follows the hour and the storm.
  vec3 amb=uHor*0.55+uMid*0.45+uSunCol*0.25*max(uSun.y,0.0);
  vec3 shallowC=mix(vec3(0.07,0.3,0.27), vec3(0.12,0.2,0.19), uStorm), deepC=mix(vec3(0.01,0.06,0.1), vec3(0.02,0.035,0.045), uStorm);
  vec3 body=mix(shallowC,deepC,deep)*amb*1.25;
  // Light filtering through a crest (cheap subsurface): brightest on wave fronts facing the sun.
  body+=shallowC*uSunCol*max(h.x-0.75,0.0)*0.6*(1.0-uStorm);
  vec3 col=mix(body, sky*0.8, clamp(fres*(0.55+0.35*calm),0.0,0.85));
  // Sun: one broad sheen, one hard highlight, and at noon (and on the dusk path) a sparkle of glints.
  float sr=max(dot(R,uSun),0.0), sun=(1.0-0.85*uStorm);
  col+=uSunCol*(pow(sr,400.0)*3.0+pow(sr,60.0)*0.05)*sun;
  // Glints are sub-texel sparkles: fade them where a cell shrinks below a pixel, or the far river turns to static.
  float px=length(fwidth(p)), near=smoothstep(0.16,0.04,px);
  vec2 gc=floor(p*vec2(5.0,8.0)+vec2(t*1.2,0.0));
  float glint=step(0.975-0.015*noon,hash(gc+floor(t*6.0)))*pow(sr,40.0)*(0.3+1.7*noon);
#ifdef HQ
  glint+=step(0.99,hash(floor(p*vec2(12.0,17.0))+floor(t*9.0)))*pow(sr,60.0)*(0.4+1.6*noon);
#endif
  glint*=near;
  col+=uSunCol*glint*sun*3.0;
  // Foam: a hard edge at the banks, a lapping line just off them, whitecaps in a storm.
  float lap=0.13+0.07*sin(t*1.7+p.x*0.8)+0.03*sin(t*0.9-p.x*2.3);
  float edge=exp(-pow(sd/0.07,2.0))+exp(-pow((sd-lap)/0.035,2.0))*0.6;
  float brk=noised(q*vec2(1.6,4.0)-vec2(t*speed*1.4,0.0)).x;
  foam=foam+edge*smoothstep(0.25,0.6,brk)+pf*smoothstep(0.2,0.55,brk);
  foam+=smoothstep(1.2-uStorm*0.35,1.45-uStorm*0.3,h.x)*(0.25+0.75*uStorm);
  foam=clamp(foam,0.0,1.0);
  vec3 fc=amb*1.7+uSunCol*0.35*max(uSun.y,0.1);
  col=mix(col,fc,foam*0.85);
  col+=uFlash*vec3(0.5,0.6,0.9)*(0.25+fres);
  float a=mix(0.62,0.95,deep)+foam*0.3;
  gl_FragColor=vec4(col,clamp(a,0.0,1.0));
  #include <fog_fragment>
}`;

type U = { value: any };
interface Wader { x: number; z: number; r: number; s: number }

class River {
  mesh!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private u!: Record<string, U>;
  private next = 0;
  private size: number = RIPPLES.high;
  private sound = -9;
  /** Source of the units currently standing in the water, set by the game (for their foam collars). */
  waders: () => Iterable<Wader> = () => [];

  /**
   * Build the water surface. `sky` holds the weather's shared sky uniforms (by reference); `ground` is
   * the terrain height, baked once into a depth map along the river for shallows and bank foam.
   */
  build(sky: Record<string, U>, ground: (x: number, z: number) => number) {
    const data = new Uint8Array(DW * DH);
    for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) {
      const x = -SPAN + (2 * SPAN * (i + 0.5)) / DW, z = riverCenter(x) - HALF + (2 * HALF * (j + 0.5)) / DH;
      data[j * DW + i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + (WATER_Y - ground(x, z)) * 0.5)));
    }
    const depth = new THREE.DataTexture(data, DW, DH, THREE.RedFormat, THREE.UnsignedByteType);
    depth.magFilter = depth.minFilter = THREE.LinearFilter; depth.needsUpdate = true;
    const rip = Array.from({ length: MAX_RIP }, () => new THREE.Vector4(0, 0, -1e4, 0));
    const wade = Array.from({ length: WADERS }, () => new THREE.Vector4());
    const mat = new THREE.ShaderMaterial({
      transparent: true, fog: true, depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 0 }, uStorm: { value: 0 }, uRain: { value: 0 },
      }]),
      vertexShader: VERT, fragmentShader: FRAG,
    });
    // Shared by reference: the clock, the sky palette, the lightning flash; the ripple arrays are ours.
    Object.assign(mat.uniforms, { uTime: timeU, uDepth: { value: depth }, uRip: { value: rip }, uWade: { value: wade },
      uZen: sky.uZen, uMid: sky.uMid, uHor: sky.uHor, uHorSun: sky.uHorSun, uSunCol: sky.uSunCol, uFlash: sky.uFlash });
    this.u = mat.uniforms;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2), mat);
    this.mesh.position.y = WATER_Y;
    this.mesh.renderOrder = 1;
    fx.onWater = (x, z, s) => this.ripple(x, z, s);
    this.applyQuality(quality.s);
    return this.mesh;
  }

  /** Ripple count and wave detail follow the tier (a define, so the shader is rebuilt once per switch). */
  applyQuality(s: Settings) {
    const tier = (Object.keys(TIERS) as Tier[]).find((k) => TIERS[k] === s) ?? 'high';
    const m = this.mesh.material, n = RIPPLES[tier], hq = tier === 'high';
    if (m.defines.NRIP === n && !!m.defines.HQ === hq) return;
    m.defines = hq ? { NRIP: n, HQ: 1 } : { NRIP: n };
    m.needsUpdate = true;
    this.size = n; this.next = 0; this.clear();
  }

  /** Weather: time of day (0 dawn .. 1 dusk), storm and rain in 0..1, and the sun's direction. */
  mood(time: number, storm: number, rain: number, sun: THREE.Vector3) {
    this.u.uDay.value = time; this.u.uStorm.value = storm; this.u.uRain.value = rain; this.u.uSun.value.copy(sun);
  }

  /** A ring spreading from (x, z); strength ~0.3 (a step) .. 1.5 (a body falling in). */
  ripple(x: number, z: number, strength = 1, delay = 0) {
    const r = this.u.uRip.value[this.next] as THREE.Vector4;
    r.set(x, z, timeU.value + delay, Math.min(1.6, strength));
    this.next = (this.next + 1) % this.size;
  }

  /** Forget every ripple (undo, restart, scrubbing). */
  clear() { for (const r of this.u.uRip.value as THREE.Vector4[]) r.set(0, 0, -1e4, 0); }

  /** Open water (not a bridge deck, not the bank) at (x, z)? */
  isWater(x: number, z: number) { return Math.abs(z) < BANK && inWater(x, z); }

  /**
   * A unit wading: spray and a slosh as it moves, a ring every so often, a big splash where it enters.
   * `weight` scales everything (a soldier ~0.6, a chariot 1.5); `d` is the distance moved this frame.
   */
  wade(st: { wet: boolean; last: number }, p: THREE.Vector3, weight: number, d: number) {
    const wet = this.isWater(p.x, p.z), t = timeU.value;
    if (wet && !st.wet) { this.splash(p, weight * 1.2); st.last = t; }
    else if (!wet && st.wet) { fx.splash(p, Math.round(6 * weight), 0.6 * weight); this.ripple(p.x, p.z, 0.5 * weight); }
    st.wet = wet;
    if (!wet || d < 0.001) return;
    if (Math.random() < 0.7) fx.splash(p, Math.max(1, Math.round(3 * weight)), 0.55 + 0.35 * weight);
    if (t - st.last > 0.22) { st.last = t; this.ripple(p.x, p.z, 0.35 + 0.3 * weight); }
    if (clock.real - this.sound > 0.26) { this.sound = clock.real; sfx.wade(weight); }
  }

  /** Something heavy hits the water: a burst of spray, a crown of rings and the sound of it. */
  splash(p: { x: number; z: number }, power = 1) {
    const v = new THREE.Vector3(p.x, WATER_Y, p.z);
    fx.splash(v, Math.round(14 * power), 0.8 + 0.5 * power);
    for (let i = 0; i < 6 * power; i++) fx.alpha.emit({ x: p.x + (Math.random() - 0.5) * 0.6, y: WATER_Y + 0.1, z: p.z + (Math.random() - 0.5) * 0.6,
      vx: (Math.random() - 0.5) * 1.5, vy: 1 + Math.random() * 1.5 * power, vz: (Math.random() - 0.5) * 1.5, life: 0.9, size: 0.5, size2: 1.4 * power, c: 0xe6f2ff, a: 0.35, grav: 3, drag: 1.5 });
    this.ripple(p.x, p.z, 0.8 * power); this.ripple(p.x, p.z, 0.6 * power, 0.25); if (power > 1) this.ripple(p.x, p.z, 0.5 * power, 0.55);
    sfx.splash(power);
  }

  update() {
    const w = this.u.uWade.value as THREE.Vector4[];
    let i = 0;
    for (const u of this.waders()) { if (i >= WADERS) break; if (this.isWater(u.x, u.z)) w[i++].set(u.x, u.z, u.r, u.s); }
    for (; i < WADERS; i++) w[i].w = 0;
  }
}

export const river = new River();

/** Bridges, for the choreography: is the river stretch between two points clear of every deck by `gap`? */
export function clearOfBridges(x0: number, z0: number, x1: number, z1: number, gap = 1.35) {
  for (let i = 0; i <= 24; i++) {
    const k = i / 24, x = x0 + (x1 - x0) * k, z = z0 + (z1 - z0) * k;
    if (Math.abs(z) < BANK + 0.3 && BRIDGE_X.some((bx) => Math.abs(x - bx) < gap)) return false;
  }
  return true;
}
