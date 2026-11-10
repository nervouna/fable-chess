// DOM overlay: turn indicator, captured trays, move list, tool buttons, banners.
import type { Move, Side } from './engine';
import { GLYPH } from './units';

const $ = (id: string) => document.getElementById(id)!;

export type Mode = 'pvp' | 'pve' | 'watch';
export interface HudHandlers { reset(): void; undo(): void; restart(): void; mode(m: Mode): void; music(on: boolean): void; fine(on: boolean): void; autoCam(on: boolean): void; badges(on: boolean): void; sound(on: boolean): void }

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
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'r' || k === ' ') { h.reset(); e.preventDefault(); }
      else if (k === 'z') h.undo();
      else if (k === 'n') h.restart();
      else if (k === 'c') cam.click();
      else if (k === 'g') badge.click();
      else if (k === 'm') snd.click();
      else if (k === 'b') mus.click();
      else if (k === 'h') fine.click();
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
}

export const hud = new Hud();
