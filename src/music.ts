// Adaptive procedural score: war drums, plucked zither and a low ostinato, layered by tension.
// Built against BaseAudioContext so the same graph renders in an OfflineAudioContext for testing.

const SCALE = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46]; // D minor pentatonic from D3
const BASS = [73.42, 73.42, 87.31, 73.42, 73.42, 73.42, 110.0, 98.0];
const DRUMS: number[][][] = [ // [step, velocity] per tension level
  [[0, 0.5]],
  [[0, 0.8], [8, 0.65], [12, 0.35]],
  [[0, 0.9], [3, 0.45], [6, 0.6], [8, 0.8], [11, 0.45], [14, 0.6]],
  [[0, 1], [2, 0.5], [4, 0.6], [6, 0.85], [8, 0.95], [10, 0.5], [12, 0.65], [14, 0.9]],
];

export class Score {
  /** 0 (calm) .. 1 (battle at its height); read at every step. */
  tension = 0.1;
  counts = { drum: 0, rim: 0, pluck: 0, bass: 0 };
  readonly out: GainNode;
  private ctx: BaseAudioContext;
  private wet: AudioNode | null;
  private noise: AudioBuffer;
  private drone: GainNode;
  private step = 0;
  private bar = 0;
  private next = 0;
  private level = 0;
  private note = 5;
  private motif: (number | null)[] = [];
  private started = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode, wet: AudioNode | null = null) {
    this.ctx = ctx; this.wet = wet;
    this.out = ctx.createGain(); this.out.gain.value = 0.5; this.out.connect(dest);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.drone = ctx.createGain(); this.drone.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    this.drone.connect(lp); lp.connect(this.out);
  }

  start(t0: number) {
    if (this.started) return;
    this.started = true; this.next = t0 + 0.05;
    for (const [f, det] of [[73.42, 0], [73.42, 7], [110.0, -5]]) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(this.drone); o.start(t0);
    }
    this.drone.gain.setTargetAtTime(0.05, t0, 1.5);
  }

  /** Schedule every step that starts before `until` (audio-clock seconds). */
  schedule(until: number, now = 0) {
    if (!this.started) return;
    if (this.next < now) this.next = now + 0.03; // the timer was throttled: resync rather than burst
    while (this.next < until) {
      const T = Math.min(1, Math.max(0, this.tension)), dur = 60 / (66 + 58 * T) / 4;
      this.playStep(this.next, T, dur);
      this.next += dur;
      if (++this.step === 16) { this.step = 0; this.bar++; }
    }
  }

  /** A capture lands: stinger now, and the groove restarts on this beat. */
  hit(t: number) {
    if (!this.started) return;
    this.drum(t, 1.15); this.rim(t, 0.9);
    this.gliss(t + 0.02, 1);
    this.step = 1; this.next = t + 60 / (66 + 58 * Math.min(1, this.tension)) / 4;
  }

  private playStep(t: number, T: number, dur: number) {
    const s = this.step, lv = T < 0.2 ? 0 : T < 0.5 ? 1 : T < 0.8 ? 2 : 3;
    if (s === 0) {
      if (lv > this.level) this.gliss(t, 1); // announce each escalation
      this.level = lv;
      if (this.bar % 2 === 0) this.newMotif(lv);
      this.drone.gain.setTargetAtTime(0.04 + 0.05 * T, t, 0.8);
    }
    for (const [st, v] of DRUMS[lv]) if (st === s && (lv > 0 || this.bar % 2 === 0)) this.drum(t, v * (0.75 + 0.25 * T));
    if (lv >= 2 && (s === 4 || s === 12)) this.rim(t, 0.5);
    if (lv === 3 && s >= 12) this.rim(t, 0.25 + 0.12 * (s - 12));
    if (lv >= 2 && s % (lv === 3 ? 2 : 4) === 0) this.bass(t, BASS[(s / 2) % 8], 0.5 + 0.3 * T, dur * (lv === 3 ? 1.6 : 3));
    const m = this.motif[s];
    if (m !== null && m !== undefined) {
      this.note = Math.max(0, Math.min(SCALE.length - 1, this.note + m));
      this.pluck(t, SCALE[this.note], 0.5 + 0.35 * T + (s % 4 === 0 ? 0.12 : 0));
      if (lv === 3 && Math.random() < 0.5) this.pluck(t + dur * 0.5, SCALE[this.note], 0.35); // tremolo
    }
  }

  /** A two-bar phrase is one bar of intervals, played twice so the ear catches the repeat. */
  private newMotif(lv: number) {
    const p = [0.22, 0.4, 0.55, 0.7][lv];
    this.motif = [];
    for (let s = 0; s < 16; s++) {
      const on = s === 0 || Math.random() < (s % 2 === 0 ? p : p * 0.3);
      this.motif.push(on ? [-2, -1, -1, 0, 1, 1, 2, 3][(Math.random() * 8) | 0] : null);
    }
    if (this.note > 9) this.motif[0] = -3; else if (this.note < 2) this.motif[0] = 3; // keep the line in range
  }

  private env(t: number, peak: number, dur: number, attack = 0.004) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out); if (this.wet) g.connect(this.wet);
    return g;
  }
  private burst(t: number, dur: number, vol: number, type: BiquadFilterType, freq: number) {
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter();
    s.buffer = this.noise; s.loop = true; f.type = type; f.frequency.value = freq;
    s.connect(f); f.connect(this.env(t, vol, dur)); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
  private drum(t: number, v: number) {
    this.counts.drum++;
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(118, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.32);
    o.connect(this.env(t, 0.75 * v, 0.42)); o.start(t); o.stop(t + 0.45);
    this.burst(t, 0.09, 0.22 * v, 'lowpass', 900);
  }
  private rim(t: number, v: number) {
    this.counts.rim++;
    this.burst(t, 0.035, 0.3 * v, 'highpass', 3500);
    const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 820;
    o.connect(this.env(t, 0.12 * v, 0.04)); o.start(t); o.stop(t + 0.06);
  }
  private pluck(t: number, f: number, v: number) {
    this.counts.pluck++;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * 9, t); lp.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.3);
    lp.connect(this.env(t, 0.2 * v, 1.5, 0.003));
    for (const [type, mul, det] of [['sawtooth', 1, 0], ['triangle', 2, 6]] as [OscillatorType, number, number][]) {
      const o = this.ctx.createOscillator(); o.type = type; o.detune.value = det;
      o.frequency.setValueAtTime(f * mul * 1.014, t); o.frequency.exponentialRampToValueAtTime(f * mul, t + 0.06); // the string settles from the pluck
      o.connect(lp); o.start(t); o.stop(t + 1.55);
    }
  }
  private bass(t: number, f: number, v: number, dur: number) {
    this.counts.bass++;
    const o = this.ctx.createOscillator(), lp = this.ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = 340;
    o.connect(lp); lp.connect(this.env(t, 0.3 * v, Math.max(0.12, dur), 0.008)); o.start(t); o.stop(t + dur + 0.05);
  }
  /** Sweep across the strings. */
  private gliss(t: number, dir: number) {
    for (let i = 0; i < 9; i++) this.pluck(t + i * 0.032, SCALE[dir > 0 ? i + 2 : 10 - i], 0.3 + i * 0.04);
  }
}

/** Live wrapper: owns the Score once audio is unlocked and keeps it scheduled a little ahead. */
class Music {
  score: Score | null = null;
  private ctx: AudioContext | null = null;
  private on = true;
  tension = 0.1;
  attach(ctx: AudioContext, dest: AudioNode, wet: AudioNode) {
    if (this.score) return;
    this.ctx = ctx; this.score = new Score(ctx, dest, wet);
    this.score.out.gain.value = this.on ? 0.5 : 0;
    this.score.start(ctx.currentTime);
  }
  setOn(on: boolean) { this.on = on; if (this.score && this.ctx) this.score.out.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.1); }
  tick() {
    if (!this.score || !this.ctx || this.ctx.state !== 'running') return;
    this.score.tension = this.tension;
    this.score.schedule(this.ctx.currentTime + 0.25, this.ctx.currentTime);
  }
  hit() { if (this.score && this.ctx && this.ctx.state === 'running' && this.on) this.score.hit(this.ctx.currentTime + 0.01); }
}

export const music = new Music();
