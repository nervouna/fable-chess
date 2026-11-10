// Render quality tiers: what each tier spends, how the first one is picked, and switching at run time.
import * as THREE from 'three';

export type Tier = 'high' | 'mid' | 'low';
export const TIER_NAMES: Tier[] = ['low', 'mid', 'high'];
export type Detail = 'full' | 'mid' | 'lo';

export interface Settings {
  /** Cap on the device pixel ratio. */
  dpr: number;
  shadowSize: number;
  shadowType: THREE.ShadowMapType;
  /** MSAA samples on the composer's render target. */
  msaa: number;
  /** Bloom resolution as a share of the frame; 0 turns bloom off. */
  bloom: number;
  /** Share of particles emitted, and the size of the live particle pools. */
  particles: number;
  /** Share of rain streaks drawn. */
  rain: number;
  /** Share of rubble thrown up by impacts and of wreckage left on the field. */
  debris: number;
  /** Unit models: 'full' is the authored glb part by part; 'mid' and 'lo' are decimated and merged into one mesh per bone. */
  models: Detail;
  /** Terrain grid resolution. */
  terrain: number;
  /** Merge static scenery that shares a material into single meshes. */
  merge: boolean;
  /** Trees, rocks and tents outside the board cast shadows. */
  propShadows: boolean;
}

export const TIERS: Record<Tier, Settings> = {
  // Exactly the settings the game shipped with.
  high: { dpr: 2, shadowSize: 4096, shadowType: THREE.PCFSoftShadowMap, msaa: 4, bloom: 1, particles: 1, rain: 1, debris: 1, models: 'full', terrain: 250, merge: false, propShadows: true },
  mid: { dpr: 1.5, shadowSize: 2048, shadowType: THREE.PCFShadowMap, msaa: 2, bloom: 0.5, particles: 0.7, rain: 0.6, debris: 0.7, models: 'mid', terrain: 160, merge: true, propShadows: true },
  low: { dpr: 1, shadowSize: 1024, shadowType: THREE.PCFShadowMap, msaa: 0, bloom: 0, particles: 0.45, rain: 0.35, debris: 0.4, models: 'lo', terrain: 100, merge: true, propShadows: false },
};

const KEY = 'fable-chess.quality', PROBED = 'fable-chess.quality.probed';
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const isTier = (v: unknown): v is Tier => v === 'high' || v === 'mid' || v === 'low';

/** A first guess from the device: phones and small machines start lower. */
function guess(): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mem = nav.deviceMemory ?? 8, cores = nav.hardwareConcurrency || 8;
  if (coarse) return mem >= 6 && cores >= 8 ? 'mid' : 'low';
  if (mem <= 2 || cores <= 2) return 'low';
  if (mem <= 4 || cores <= 4) return 'mid';
  return 'high';
}

/** Where the starting tier came from: the URL (?q=), the player's saved choice, an earlier frame-time probe, or a guess. */
export type Source = 'url' | 'saved' | 'probed' | 'auto';

class Quality {
  tier: Tier;
  source: Source;
  /** Called with the new settings after the tier changes; may load models, so it can be async. */
  onChange: ((s: Settings, tier: Tier) => void | Promise<void>)[] = [];

  constructor() {
    const url = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('q') : null;
    const saved = store.get(KEY), probed = store.get(PROBED);
    if (isTier(url)) { this.tier = url; this.source = 'url'; }
    else if (isTier(saved)) { this.tier = saved; this.source = 'saved'; }
    else if (isTier(probed)) { this.tier = probed; this.source = 'probed'; }
    else { this.tier = guess(); this.source = 'auto'; }
  }

  get s(): Settings { return TIERS[this.tier]; }

  /** Switch tiers. `save` remembers the choice for later visits. Resolves once every listener is done. */
  set(tier: Tier, save = true): Promise<void> {
    if (save) store.set(KEY, tier);
    if (tier === this.tier) return this.busy;
    this.tier = tier;
    // Switches run one after another, so a quick double click cannot leave half of one tier loaded.
    return (this.busy = this.busy.then(async () => { for (const f of this.onChange) await f(TIERS[tier], tier); }).catch((e) => console.error('quality switch failed:', e)));
  }
  private busy = Promise.resolve();

  /** The next tier round the cycle low -> mid -> high -> low (for the HUD button). */
  next(): Tier { return TIER_NAMES[(TIER_NAMES.indexOf(this.tier) + 1) % 3]; }

  /**
   * Only for an automatic first choice: time real frames for a couple of seconds and step down a tier
   * while the median frame is slower than ~30 fps. Hidden tabs (no rAF) and stalls are ignored.
   */
  probe(skip: () => boolean = () => false) {
    if (this.source !== 'auto') return;
    let last = 0, warm = 0;
    const times: number[] = [];
    const frame = (now: number) => {
      const dt = now - last; last = now;
      if (document.visibilityState !== 'visible' || skip() || dt > 250 || warm++ < 30) { requestAnimationFrame(frame); return; }
      times.push(dt);
      if (times.length < 90) { requestAnimationFrame(frame); return; }
      const med = times.sort((a, b) => a - b)[45];
      const i = TIER_NAMES.indexOf(this.tier);
      if (med > 34 && i > 0) { void this.set(TIER_NAMES[i - 1], false).then(() => { times.length = 0; warm = 0; requestAnimationFrame(frame); }); return; }
      store.set(PROBED, this.tier);
    };
    requestAnimationFrame(frame);
  }
}

export const quality = new Quality();
