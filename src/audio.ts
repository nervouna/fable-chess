// Fully procedural sound effects (WebAudio synthesis, no audio files).
import { music } from './music';

class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;
  private rainGain: GainNode | null = null;
  private comp!: DynamicsCompressorNode;
  private tap: MediaStreamAudioDestinationNode | null = null;
  muted = false;

  /** Must be called from a user gesture to unlock audio. */
  unlock() {
    if (!this.ctx) {
      try { this.ctx = new AudioContext(); } catch { return; }
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.8;
      const comp = this.comp = c.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(c.destination);
      // Cheap synthetic reverb for a sense of open space.
      const len = c.sampleRate * 1.8, ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
      const verb = c.createConvolver(); verb.buffer = ir;
      this.wet = c.createGain(); this.wet.gain.value = 0.28;
      this.wet.connect(verb); verb.connect(this.master);
      this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const n = this.noiseBuf.getChannelData(0); for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
      this.ambience();
      // Rain bed: filtered noise whose level follows the weather.
      const rs = c.createBufferSource(), rf = c.createBiquadFilter();
      rs.buffer = this.noiseBuf; rs.loop = true; rf.type = 'highpass'; rf.frequency.value = 1800;
      this.rainGain = c.createGain(); this.rainGain.gain.value = 0;
      rs.connect(rf); rf.connect(this.rainGain); this.rainGain.connect(this.master); rs.start();
      music.attach(c, this.master, this.wet);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** The final mix as a stream (for recording), alongside the speakers. Null while audio is not running. */
  capture(): MediaStream | null {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    if (!this.tap) { this.tap = this.ctx.createMediaStreamDestination(); this.comp.connect(this.tap); }
    return this.tap.stream;
  }
  /** Disconnect the recording tap. */
  release() { if (this.tap) { this.comp.disconnect(this.tap); this.tap = null; } }

  setMuted(m: boolean) { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05); }

  private ok() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }

  private out(vol: number, t0: number, dur: number, attack = 0.004) {
    const c = this.ctx!, g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(this.master); g.connect(this.wet);
    return g;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    if (!this.ok()) return;
    const c = this.ctx!, t0 = c.currentTime + delay, o = c.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    o.connect(this.out(vol, t0, dur)); o.start(t0); o.stop(t0 + dur + 0.02);
  }

  private nz(dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q = 1, delay = 0, attack = 0.004) {
    if (!this.ok()) return;
    const c = this.ctx!, t0 = c.currentTime + delay, s = c.createBufferSource(), f = c.createBiquadFilter();
    s.buffer = this.noiseBuf; s.loop = true;
    f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t0 + dur);
    s.connect(f); f.connect(this.out(vol, t0, dur, attack)); s.start(t0, Math.random()); s.stop(t0 + dur + 0.02);
  }

  private ambience() {
    const c = this.ctx!, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    s.buffer = this.noiseBuf; s.loop = true; f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.6; g.gain.value = 0.035;
    lfo.frequency.value = 0.13; lg.gain.value = 180; lfo.connect(lg); lg.connect(f.frequency);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(); lfo.start();
    const beat = () => { // distant war drums
      if (this.ok()) { this.tone('sine', 62, 38, 0.5, 0.1); this.tone('sine', 62, 38, 0.5, 0.07, 0.42); }
      setTimeout(beat, 5200 + Math.random() * 5000);
    };
    setTimeout(beat, 2500);
  }

  /** Rain loudness 0..1. */
  setRain(v: number) { if (this.rainGain && this.ctx) this.rainGain.gain.setTargetAtTime(v * 0.11, this.ctx.currentTime, 0.3); }
  thunder(delay = 0) {
    this.nz(0.25, 0.5, 'highpass', 1200, 300, 0.7, delay, 0.01); // crack
    this.nz(3.2, 0.7, 'lowpass', 420, 50, 0.8, delay + 0.05, 0.08); // rolling rumble
    this.tone('sine', 62, 24, 2.6, 0.55, delay + 0.05);
  }

  // ----- UI -----
  select() { this.tone('triangle', 660, 880, 0.09, 0.14); this.nz(0.04, 0.1, 'highpass', 3000, 5000); }
  place() { this.tone('sine', 150, 70, 0.14, 0.3); this.nz(0.05, 0.14, 'lowpass', 900, 300); }
  error() { this.tone('square', 150, 110, 0.14, 0.07); }
  // ----- movement -----
  step() { this.nz(0.07, 0.13, 'bandpass', 420, 220, 1.2); }
  heavyStep() { this.tone('sine', 95, 45, 0.2, 0.32); this.nz(0.09, 0.14, 'lowpass', 500, 180); }
  hoof(delay = 0) { this.nz(0.05, 0.3, 'bandpass', 1100, 600, 3, delay); this.tone('sine', 190, 90, 0.07, 0.2, delay); }
  stomp(p = 1) { this.tone('sine', 70, 26, 0.55, 0.55 * p); this.nz(0.35, 0.3 * p, 'lowpass', 320, 60); }
  whoosh() { this.nz(0.32, 0.22, 'bandpass', 500, 2600, 1.4, 0, 0.12); }
  rumble(dur: number) { this.nz(dur, 0.3, 'lowpass', 160, 260, 1, 0, dur * 0.3); this.nz(dur, 0.08, 'bandpass', 1400, 900, 6, 0, dur * 0.3); }
  creak(dur: number) { this.nz(dur, 0.12, 'bandpass', 300, 380, 5, 0, 0.1); this.tone('sawtooth', 70, 85, dur, 0.03); }
  splash() { this.nz(0.35, 0.2, 'bandpass', 1800, 700, 0.8, 0, 0.02); }
  neigh(p = 1) { if (!this.ok()) return; this.tone('sawtooth', 900 * p, 1500 * p, 0.12, 0.06); this.tone('sawtooth', 1500 * p, 600 * p, 0.38, 0.07, 0.12); this.tone('square', 1400 * p, 500 * p, 0.38, 0.02, 0.12); }
  trumpet(p = 1) { this.tone('sawtooth', 240 * p, 520 * p, 0.25, 0.1); this.tone('sawtooth', 520 * p, 420 * p, 0.6, 0.12, 0.25); this.tone('square', 523 * p, 415 * p, 0.6, 0.04, 0.25); }
  // ----- combat -----
  charge() { this.tone('sine', 220, 1300, 0.45, 0.1); this.nz(0.45, 0.08, 'bandpass', 800, 5000, 3, 0, 0.3); }
  slash() { this.nz(0.2, 0.3, 'bandpass', 5200, 1200, 1.2, 0, 0.01); }
  clang() { for (const [f, v] of [[1870, 0.12], [2630, 0.1], [3410, 0.08], [4720, 0.05]]) this.tone('sine', f, f * 0.995, 0.5, v); this.nz(0.05, 0.25, 'highpass', 4000, 6000); }
  fuse() { this.nz(0.42, 0.1, 'highpass', 5000, 7000, 1, 0, 0.05); }
  boom(v = 1) { this.tone('sine', 150, 28, 0.6, 0.85 * v); this.nz(0.5, 0.6 * v, 'lowpass', 2400, 90); }
  explode() { this.tone('sine', 110, 20, 1.1, 0.95); this.nz(1.2, 0.75, 'lowpass', 3200, 60); this.nz(0.25, 0.4, 'highpass', 2000, 800); }
  crash() { this.nz(0.5, 0.55, 'lowpass', 2800, 200); this.tone('square', 130, 45, 0.3, 0.2); for (let i = 0; i < 4; i++) this.nz(0.08, 0.2, 'bandpass', 700 + i * 500, 400, 4, 0.05 + i * 0.07); }
  thud() { this.tone('sine', 110, 40, 0.22, 0.45); this.nz(0.12, 0.2, 'lowpass', 600, 150); }
  grunt() { this.tone('sawtooth', 190, 95, 0.22, 0.09); }
  vanish() { this.tone('sine', 520, 1900, 0.5, 0.05); this.nz(0.5, 0.05, 'highpass', 3000, 9000, 1, 0, 0.2); }
  gong() { for (const [f, v] of [[98, 0.4], [147, 0.25], [196.5, 0.2], [262, 0.14], [331, 0.1], [415, 0.06]]) this.tone('sine', f, f * 0.985, 3.2, v); this.nz(0.5, 0.2, 'bandpass', 900, 300, 2); }
  check() { this.tone('sine', 196, 194, 1.4, 0.3); this.tone('sine', 294, 292, 1.4, 0.2); this.tone('triangle', 588, 584, 0.6, 0.12); this.nz(0.2, 0.14, 'bandpass', 1500, 500, 2); }
  drum(delay = 0, v = 1) { this.tone('sine', 120, 42, 0.4, 0.7 * v, delay); this.nz(0.1, 0.25 * v, 'lowpass', 900, 200, 1, delay); }
  victory() { [0, 0.22, 0.44, 0.6, 0.76, 0.88, 1.0].forEach((d, i) => this.drum(d, 0.6 + i * 0.07)); this.gong(); [392, 523, 659, 784].forEach((f, i) => this.tone('triangle', f, f, 1.2, 0.12, 1.1 + i * 0.16)); }
}

export const sfx = new Sfx();
