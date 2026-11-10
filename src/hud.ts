// DOM overlay: turn indicator, captured trays, move list, tool buttons, banners.
import type { Move, Side } from './engine';
import { GLYPH } from './units';

const $ = (id: string) => document.getElementById(id)!;

export type Mode = 'pvp' | 'pve' | 'watch';
export interface HudHandlers { reset(): void; undo(): void; restart(): void; mode(m: Mode): void; music(on: boolean): void; fine(on: boolean): void; autoCam(on: boolean): void; badges(on: boolean): void; sound(on: boolean): void; replay: ReplayHandlers; reel: ReelHandlers; classics: ClassicHandlers }
/** The classic games: what the picker lists, and replaying one. */
export interface ClassicHandlers { list: readonly { title: string; source: string; blurb: string }[]; play(i: number): void }
/** Replay controls. `share` returns the link and the readable record of the game on screen. */
/** Highlight reel: play it, play and record it, leave it (which also cancels a recording). */
export interface ReelHandlers { start(): void; export(): void; exit(): void }
export interface ReplayHandlers { enter(): void; prev(): void; next(): void; toggle(): void; speed(): void; seek(ply: number): void; exit(): void; share(): { link: string; text: string } }

class Hud {
  private root = $('hud');
  private bannerTimer = 0;
  private duelTimer = 0;

  init(h: HudHandlers) {
    $('btn-reset').onclick = h.reset;
    $('btn-undo').onclick = h.undo; $('over-undo').onclick = h.undo;
    $('btn-new').onclick = h.restart; $('over-new').onclick = h.restart;
    const toggle = (id: string, fn: (on: boolean) => void) => { const b = $(id); b.onclick = () => fn(b.classList.toggle('on')); return b; };
    const cam = toggle('btn-cam', h.autoCam), badge = toggle('btn-badge', h.badges), snd = toggle('btn-sound', h.sound), mus = toggle('btn-music', h.music);
    const fine = toggle('btn-fine', h.fine);
    const modes: Mode[] = ['pvp', 'pve', 'watch'];
    for (const m of modes) $('mode-' + m).onclick = () => h.mode(m);
    const r = h.replay;
    for (const id of ['btn-replay', 'tool-replay', 'over-replay']) $(id).onclick = r.enter;
    for (const id of ['btn-share', 'tool-share', 'rp-share']) $(id).onclick = () => this.openShare(r.share());
    $('rp-prev').onclick = r.prev; $('rp-next').onclick = r.next; $('rp-play').onclick = r.toggle; $('rp-speed').onclick = r.speed; $('rp-exit').onclick = r.exit;
    const range = $('rp-range') as HTMLInputElement;
    range.oninput = () => r.seek(+range.value);
    range.onchange = () => range.blur();
    $('share-close').onclick = () => this.closeShare();
    $('share').onclick = (e) => { if (e.target === $('share')) this.closeShare(); };
    $('share-link').onclick = () => void this.copy(this.shared.link, '链接已复制');
    $('share-text').onclick = () => void this.copy(this.shared.text, '棋谱已复制');
    const rl = h.reel;
    $('over-reel').onclick = rl.start; $('share-reel').onclick = rl.start; $('share-export').onclick = rl.export;
    $('rl-export').onclick = rl.export; $('rl-exit').onclick = rl.exit;
    $('video-close').onclick = () => this.closeVideo();
    $('video').onclick = (e) => { if (e.target === $('video')) this.closeVideo(); };
    const cl = h.classics, list = $('cl-list');
    cl.list.forEach((c, i) => {
      const b = document.createElement('button');
      b.innerHTML = '<span class="t"></span><span class="s"></span><span class="b"></span>';
      b.querySelector('.t')!.textContent = c.title; b.querySelector('.s')!.textContent = c.source; b.querySelector('.b')!.textContent = c.blurb;
      b.onclick = () => cl.play(i);
      list.append(b);
    });
    for (const id of ['btn-classics', 'rp-classics']) $(id).onclick = () => this.openClassics();
    $('cl-close').onclick = () => this.closeClassics();
    $('classics').onclick = (e) => { if (e.target === $('classics')) this.closeClassics(); };
    $('video-share').onclick = () => { // synchronously inside the click: share sheets need the gesture
      if (this.videoFile) navigator.share({ files: [this.videoFile], title: '楚漢爭鋒 · 集锦' }).catch(() => {});
    };
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if ((e.target as HTMLElement).id === 'share-url' && k !== 'escape') return; // the scrubber is exempt: its keys are ours
      if (k === 'escape' && this.videoOpen) { this.closeVideo(); return; }
      if (this.classicsOpen) { if (k === 'escape') this.closeClassics(); return; } // the picker owns the keys (Tab, Enter, Space pick)
      if (this.reeling) {
        // The reel owns the keyboard: Esc leaves it, nothing else may move the board underneath.
        if (k === 'escape') rl.exit();
        if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
        return;
      }
      if (this.replaying) {
        // Replay keys take over the arrows, space and escape; the rest keep their meaning.
        if (k === 'arrowleft') { r.prev(); e.preventDefault(); return; }
        if (k === 'arrowright') { r.next(); e.preventDefault(); return; }
        if (k === ' ') { r.toggle(); e.preventDefault(); return; }
        if (k === 'escape') { if (this.shareOpen) this.closeShare(); else r.exit(); return; }
      }
      if (k === 'escape' && this.shareOpen) this.closeShare();
      else if (k === 'p') r.enter();
      else if (k === 'l') rl.start();
      else if (k === 'k') this.openClassics();
      else if (k === 'r' || k === ' ') { h.reset(); e.preventDefault(); }
      else if (k === 'z') h.undo();
      else if (k === 'n') h.restart();
      else if (k === 'c') cam.click();
      else if (k === 'g') badge.click();
      else if (k === 'm') snd.click();
      else if (k === 'b') mus.click();
      else if (k === 'h') fine.click();
      else if (k === 'q') $('btn-quality').click();
      else if (k === '1' || k === '2' || k === '3') h.mode(modes[+k - 1]);
    });
  }

  setMode(m: Mode) {
    for (const k of ['pvp', 'pve', 'watch']) $('mode-' + k).classList.toggle('on', k === m);
    this.root.classList.toggle('watch', m === 'watch');
  }

  setTurn(side: Side, check: boolean, over: boolean, thinking = false) {
    const t = $('turn');
    t.textContent = over ? '终局' : (side === 'r' ? '红方' : '黑方') + (thinking ? (check ? ' · 被将军 · 思考中' : ' · 思考中') : check ? ' · 被将军' : '行棋');
    t.className = `turn ${side}${check && !over ? ' check' : ''}`;
    $('camp-r').classList.toggle('active', side === 'r' && !over);
    $('camp-b').classList.toggle('active', side === 'b' && !over);
  }

  setHistory(history: Move[]) {
    const ol = $('moves');
    ol.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const li = document.createElement('li');
      for (const m of history.slice(i, i + 2)) {
        const s = document.createElement('span'); s.className = m.piece.side; s.textContent = m.notation; li.append(s);
      }
      ol.append(li);
    }
    ol.scrollTop = ol.scrollHeight;
    // Each tray shows the enemy pieces that side has captured.
    for (const side of ['r', 'b'] as Side[]) {
      const tray = $('tray-' + side), caps = history.filter((m) => m.captured && m.piece.side === side);
      while (tray.children.length > caps.length) tray.lastChild!.remove();
      for (let i = tray.children.length; i < caps.length; i++) {
        const c = caps[i].captured!, d = document.createElement('div');
        d.className = 'tok ' + c.side; d.textContent = GLYPH[c.side][c.type]; tray.append(d);
      }
    }
  }

  flash(text: string, side: Side) {
    const b = $('banner');
    b.querySelector('span')!.textContent = text;
    b.className = '';
    void b.offsetWidth; // restart the animation
    b.className = 'show ' + side;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => { b.className = ''; }, 1600);
  }

  gameOver(winner: Side | null, reason: string) {
    $('over-title').textContent = winner === 'r' ? '红方胜' : winner === 'b' ? '黑方胜' : '和棋';
    $('over-sub').textContent = reason;
    $('over').className = 'show ' + (winner ?? 'd');
  }
  hideOver() { $('over').className = ''; }

  /** Title card for a capture: attacker glyph, victim glyph and the name of the duel. */
  duel(name: string, a: string, v: string, side: Side) {
    const d = $('duel');
    d.querySelector('.nm')!.textContent = name; d.querySelector('.a')!.textContent = a; d.querySelector('.v')!.textContent = v;
    d.className = '';
    void d.offsetWidth;
    d.className = 'show ' + side;
    clearTimeout(this.duelTimer);
    this.duelTimer = window.setTimeout(() => { d.className = ''; }, 2700);
  }
  duelHide() { clearTimeout(this.duelTimer); $('duel').className = ''; }

  cinematic(on: boolean) { this.root.classList.toggle('cine', on); }

  private remarkTimer = 0;
  private cardUntil = 0;
  /** One line of commentary with a small byline, for a few seconds ('' hides it). */
  remark(text: string, by: string, side: Side) {
    const c = $('remark'), hold = this.cardUntil - performance.now();
    clearTimeout(this.remarkTimer); c.className = '';
    if (!text) return;
    if (hold > 0) { this.remarkTimer = window.setTimeout(() => this.remark(text, by, side), hold); return; } // after the title card
    c.querySelector('.t')!.textContent = text; c.querySelector('.s')!.textContent = by;
    void c.offsetWidth;
    c.className = 'show ' + side;
    this.remarkTimer = window.setTimeout(() => { c.className = ''; }, 3600);
  }

  // ---------- replay ----------
  private replaying = false;
  private shareOpen = false;
  private shared = { link: '', text: '' };
  private toastTimer = 0;
  /** Show or hide the replay bar. */
  replay(on: boolean) { this.replaying = on; this.root.classList.toggle('replay', on); }
  /** Update the bar: ply shown, plies in the record, playing or paused, speed, and the result once reached. */
  replayState(ply: number, total: number, playing: boolean, speed: number, result: string) {
    const range = $('rp-range') as HTMLInputElement;
    range.max = String(total); range.value = String(ply);
    range.style.setProperty('--fill', (total ? (ply / total) * 100 : 0) + '%');
    $('rp-ply').textContent = `${ply} / ${total}`;
    $('rp-play').querySelector('b')!.textContent = playing ? '❚❚' : '▶\uFE0E';
    $('rp-play').querySelector('span')!.textContent = playing ? '暂停' : '播放';
    $('rp-speed').querySelector('b')!.textContent = speed + '×';
    $('rp-prev').toggleAttribute('disabled', ply <= 0); $('rp-next').toggleAttribute('disabled', ply >= total);
    const t = $('turn');
    t.textContent = result || `复盘 · ${ply ? '第 ' + ply + ' 手' : '开局'}`;
  }
  openShare(s: { link: string; text: string }) {
    this.shared = s; this.shareOpen = true;
    ($('share-url') as HTMLInputElement).value = s.link;
    $('share').className = 'show';
  }
  closeShare() { this.shareOpen = false; $('share').className = ''; }
  /** Copy to the clipboard, falling back to a selected text field where the API is unavailable or refused. */
  async copy(text: string, done: string) {
    try { await navigator.clipboard.writeText(text); this.toast(done); return; } catch { /* insecure context or no focus */ }
    const f = document.createElement('textarea');
    f.value = text; f.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.append(f); f.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
    f.remove();
    this.toast(ok ? done : '复制失败，请手动复制');
    if (!ok) ($('share-url') as HTMLInputElement).select();
  }
  // ---------- highlight reel ----------
  private reeling = false;
  private cardTimer = 0;
  private videoOpen = false;
  private videoFile: File | null = null;
  /** Object URL of the last exported video (revoked when replaced or closed). */
  videoUrl = '';
  /** Show or hide the reel bar; `exporting` turns it into progress and a cancel button. */
  reel(on: boolean, exporting: boolean) {
    this.reeling = on;
    this.root.classList.toggle('reel', on); this.root.classList.toggle('exporting', on && exporting);
    $('rl-exit').querySelector('span')!.textContent = exporting ? '取消' : '退出';
    $('rl-exit').title = exporting ? '取消导出 (Esc)' : '退出集锦 (Esc)';
    if (on) this.closeShare();
  }
  /** Clip `i` of `n` (n: the end), its reason, and overall progress 0..1. */
  reelState(i: number, n: number, reason: string, progress: number) {
    const no = (k: number) => '一二三四五六七八九十'[k] ?? String(k + 1);
    const ex = this.root.classList.contains('exporting');
    $('rl-text').textContent = (ex ? '导出中 · ' : '集锦 · ') + (i < n ? `其${no(i)} / ${no(n - 1)}${reason ? ' · ' + reason : ''}` : reason || '终局') + (ex ? ` · ${Math.round(progress * 100)}%` : '');
    $('rl-fill').style.width = Math.round(progress * 100) + '%';
  }
  /** Title card over the board for `life` seconds (0 hides it); `small` is the caption size. */
  reelCard(text: string, sub: string, side: Side | 'd', life: number, small = false) {
    const c = $('reelcard');
    clearTimeout(this.cardTimer); c.className = '';
    if (!life) return;
    c.querySelector('.t')!.textContent = text; c.querySelector('.s')!.textContent = sub;
    void c.offsetWidth;
    c.style.animationDuration = life + 's'; this.cardUntil = performance.now() + life * 1000;
    c.className = 'show ' + side + (small ? ' small' : '');
    this.cardTimer = window.setTimeout(() => { c.className = ''; }, life * 1000);
  }
  /** Offer an exported video: a download link, and the share sheet where files can be shared. */
  offerVideo(blob: Blob, mime: string, ms: number) {
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm', name = `楚漢爭鋒-集锦.${ext}`;
    this.videoUrl = URL.createObjectURL(blob);
    const a = $('video-dl') as HTMLAnchorElement;
    a.href = this.videoUrl; a.download = name;
    const file = new File([blob], name, { type: mime });
    let share = false;
    try { share = !!navigator.canShare?.({ files: [file] }); } catch { /* not shareable */ }
    this.videoFile = share ? file : null;
    $('video-share').style.display = share ? '' : 'none';
    $('video-note').textContent = `${ext.toUpperCase()} · ${Math.round(ms / 1000)} 秒 · ${(blob.size / 1048576).toFixed(1)} MB`;
    this.videoOpen = true; $('video').className = 'show';
  }
  closeVideo() {
    if (!this.videoOpen) return;
    this.videoOpen = false; $('video').className = ''; this.videoFile = null;
    if (this.videoUrl) { URL.revokeObjectURL(this.videoUrl); this.videoUrl = ''; ($('video-dl') as HTMLAnchorElement).removeAttribute('href'); }
  }

  // ---------- classics ----------
  private classicsOpen = false;
  /** The picker of classic games. */
  openClassics() {
    if (this.reeling) return;
    this.closeShare(); this.classicsOpen = true; $('classics').className = 'show';
    ($('cl-list').firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  }
  closeClassics() { this.classicsOpen = false; $('classics').className = ''; }

  toast(text: string) {
    const t = $('toast');
    t.textContent = text; t.className = 'show';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { t.className = ''; }, 2200);
  }
}

export const hud = new Hud();
