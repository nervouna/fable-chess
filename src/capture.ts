// Video capture of the reel. The WebGL canvas is copied each frame onto a 2D canvas that also gets the
// overlays the DOM shows (letterbox, clip and duel titles, banners, a watermark), since only canvas
// pixels are recorded. That canvas is streamed into a MediaRecorder, optionally with the game audio.
import type { Side } from './engine';

const TYPES = [
  ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1'],
  ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9'],
  ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'],
  ['video/webm', 'video/webm'],
] as const;
const KAI = '"STKaiti", "Kaiti SC", "KaiTi", "BiauKai", "Songti SC", "SimSun", serif';
const GLOW: Record<Side | 'd', string> = { r: 'rgba(255, 60, 20, 0.95)', b: 'rgba(40, 190, 255, 0.95)', d: 'rgba(255, 190, 90, 0.95)' };

/** Can this browser record the canvas at all? */
export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/** Text shown over the picture: `t` is the real time it appeared, `life` how long it stays. */
export interface Caption { text: string; sub?: string; side: Side | 'd'; t: number; life: number }
/** What the DOM overlay shows this frame, mirrored into the recording. */
export interface Overlay { time: number; letterbox: boolean; card: Caption | null; banner: Caption | null; duel: Caption | null }

export interface Recording { blob: Blob; mime: string; durationMs: number; width: number; height: number; audio: boolean }

export class Recorder {
  readonly out = document.createElement('canvas');
  private g = this.out.getContext('2d')!;
  private stream: MediaStream;
  private track: MediaStreamTrack & { requestFrame?: () => void };
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private t0 = performance.now();
  private bars = 0; // letterbox, 0..1
  private last = 0;
  private shot = -1e9; // wall time of the last frame taken
  private done: Promise<Recording>;
  onError: (e: unknown) => void = () => {};

  /** Starts recording at once. Throws if no recorder can be made. */
  constructor(private src: HTMLCanvasElement, w: number, h: number, audio: MediaStream | null) {
    this.out.width = w; this.out.height = h;
    this.stream = this.out.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    if (typeof this.track.requestFrame !== 'function') { // no manual frames here: let the browser sample instead
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = this.out.captureStream(30); this.track = this.stream.getVideoTracks()[0];
    }
    const a = audio?.getAudioTracks()[0];
    if (a) this.stream.addTrack(a.clone()); // a clone, so stopping ours leaves the game's tap alone
    let rec: MediaRecorder | null = null, err: unknown = null;
    // isTypeSupported can say yes to a combination that then fails, so fall down the list.
    for (const [withAudio, videoOnly] of TYPES) {
      const mimeType = a ? withAudio : videoOnly;
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try { rec = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: Math.min(6e6, Math.round(w * h * 30 * 0.1)), audioBitsPerSecond: 128000 }); break; } catch (e) { err = e; }
    }
    if (!rec) try { rec = new MediaRecorder(this.stream); } catch (e) { err = e; }
    if (!rec) { this.stop(); throw err ?? new Error('MediaRecorder unavailable'); }
    this.rec = rec;
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.done = new Promise((res, rej) => {
      rec.onstop = () => {
        const mime = (this.chunks[0]?.type || rec.mimeType || 'video/webm').split(';')[0];
        res({ blob: new Blob(this.chunks, { type: mime }), mime, durationMs: performance.now() - this.t0, width: w, height: h, audio: !!a });
      };
      rec.onerror = (e) => { rej(e); this.onError(e); };
    });
    this.done.catch(() => {}); // handled by onError
    rec.start(1000);
  }

  get mime() { return this.rec.mimeType; }

  /** Copy the frame just rendered and draw the overlays over it (at most 30 times a second). Call right after rendering. */
  frame(o: Overlay) {
    const now = performance.now();
    if (now - this.shot < 31) return; // 30 fps is plenty, and a 120 Hz screen would quadruple the file
    this.shot = now;
    const g = this.g, W = this.out.width, H = this.out.height;
    const dt = Math.min(0.1, Math.max(0, o.time - this.last)); this.last = o.time;
    g.globalAlpha = 1; g.shadowBlur = 0;
    // Cover-fit: if the window changes shape mid-recording the picture is cropped, never stretched.
    const sw = this.src.width, sh = this.src.height, k = Math.min(sw / W, sh / H);
    if (sw && sh) g.drawImage(this.src, (sw - W * k) / 2, (sh - H * k) / 2, W * k, H * k, 0, 0, W, H);
    this.bars += ((o.letterbox ? 1 : 0) - this.bars) * Math.min(1, dt * 9);
    if (this.bars > 0.002) { g.fillStyle = '#000'; const bh = H * 0.11 * this.bars; g.fillRect(0, 0, W, bh); g.fillRect(0, H - bh, W, bh); }
    const u = Math.min(W, H * 1.6) / 100; // type scale: 1% of a landscape frame's width
    if (o.banner) this.caption(o.banner, o.time, W / 2, H * 0.36, 9.5 * u, 'center', true);
    if (o.duel) this.caption(o.duel, o.time, W * 0.05, H * (1 - 0.11) - 2.4 * u, 5.2 * u, 'left');
    if (o.card) this.caption(o.card, o.time, W / 2, H * 0.24, (o.card.sub ? 7 : 5.4) * u, 'center');
    // Watermark
    g.globalAlpha = 0.55; g.shadowBlur = 0; g.font = `${Math.round(2.2 * u)}px ${KAI}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#e9c070'; g.fillText('楚 漢 爭 鋒', W - 2 * u, H - 1.8 * u);
    this.track.requestFrame?.();
  }

  private caption(c: Caption, now: number, x: number, y: number, size: number, align: CanvasTextAlign, slam = false) {
    const age = now - c.t;
    if (age < 0 || age > c.life) return;
    const fin = Math.min(1, age / 0.25), fout = Math.min(1, (c.life - age) / 0.4), a = Math.min(fin, fout);
    const g = this.g;
    g.save();
    g.globalAlpha = a; g.textAlign = align; g.textBaseline = 'middle';
    g.translate(x + (align === 'left' ? (1 - fin) * -40 : 0), y);
    if (slam) g.scale(1 + (1 - fin) * 1.2, 1 + (1 - fin) * 1.2);
    g.font = `${Math.round(size)}px ${KAI}`;
    g.shadowColor = GLOW[c.side]; g.shadowBlur = size * 0.35;
    g.fillStyle = '#fff3d6';
    g.fillText(c.text, 0, 0); g.fillText(c.text, 0, 0); // twice for a stronger glow
    if (c.sub) { g.font = `${Math.round(size * 0.42)}px ${KAI}`; g.shadowColor = 'rgba(0, 0, 0, 0.9)'; g.shadowBlur = size * 0.25; g.fillStyle = '#f5d48a'; g.fillText(c.sub, 0, size * 0.85); }
    g.restore();
  }

  /** Finish and return the file. */
  async finish(): Promise<Recording> {
    if (this.rec.state !== 'inactive') { this.rec.requestData(); this.rec.stop(); }
    try { return await this.done; } finally { this.stop(); }
  }
  /** Abandon the recording. */
  cancel() {
    this.chunks = [];
    if (this.rec && this.rec.state !== 'inactive') { this.rec.ondataavailable = null; this.rec.onstop = null; this.rec.stop(); }
    this.stop();
  }
  private stop() { for (const t of this.stream.getTracks()) t.stop(); this.out.width = this.out.height = 0; }
}
