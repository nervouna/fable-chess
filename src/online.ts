// Online play, page side: the 联机 card, the connection chip, the draw / undo / rematch prompts, and
// the life of a session (a WebRTC Link carrying a NetGame). main.ts mirrors the session's game on the
// board through the hooks; everything the peer says is validated in netgame.ts first.
import type { Side } from './engine';
import { hud } from './hud';
import { Link } from './net';
import { NetGame, type Ask } from './netgame';
import { SdpError } from './sdp';

export interface OnlineHooks {
  /** the board is in net mode */
  active(): boolean;
  /** a session is ready (new or resumed): enter net mode and show its game */
  begin(): void;
  /** the session's game changed */
  update(): void;
  /** leave net mode (the board stays, as a local game) */
  quit(): void;
}
type View = 'pick' | 'host' | 'invite' | 'guest' | 'live';
export type Phase = 'idle' | 'hosting' | 'joining' | 'connecting' | 'open' | 'unstable' | 'closed';

const $ = (id: string) => document.getElementById(id)!;
const SIDE = { r: '红', b: '黑' } as const;
const CLOSED: Record<string, string> = {
  bye: '对方已离开', leave: '已离开联机', lost: '连接已断开', timeout: '对方无响应，连接已断开',
  failed: '连接失败：网络可能不支持直连（对称 NAT）', version: '双方版本不同，请刷新页面后重试',
  abuse: '对方发送了过多无效消息，已断开', desync: '无法同步棋局，已断开',
};
const ASK: Record<Ask, string> = { draw: '对方提议和棋', undo: '对方请求悔棋', rematch: '对方请求再战 · 交换先后' };

class Online {
  /** The current session, or the last one (kept after a disconnect so it can be resumed). */
  game: NetGame | null = null;
  link: Link | null = null;
  invite = ''; reply = ''; error = '';
  private hooks!: OnlineHooks;
  private token = 0;
  private view: View | null = null;
  private asking: Ask | null = null;
  private resignArmed = 0; private leaveArmed = 0;

  init(h: OnlineHooks) {
    this.hooks = h;
    const pick = (side: Side | 'random' | 'resume') => () => void this.host(side).catch(() => {});
    $('net-local').onclick = () => this.close();
    $('net-online').onclick = () => this.show('host');
    $('net-red').onclick = pick('r'); $('net-black').onclick = pick('b'); $('net-random').onclick = pick('random'); $('net-resume').onclick = pick('resume');
    $('net-copy').onclick = () => void hud.copy(this.invite, '邀请链接已复制', 'net-invite');
    $('net-share').onclick = () => { navigator.share?.({ title: '楚漢爭鋒 · 联机邀请', url: this.invite }).catch(() => {}); };
    const reply = $('net-reply') as HTMLInputElement, go = () => void this.accept(reply.value).catch(() => {});
    $('net-accept').onclick = go;
    reply.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('net-copy-reply').onclick = () => void hud.copy(this.reply, '回复码已复制', 'net-answer');
    $('net-draw').onclick = () => this.offer('draw');
    $('net-undo').onclick = () => this.offer('undo');
    $('net-resign').onclick = () => this.resign();
    $('net-leave').onclick = () => { if (this.hooks.active()) this.hooks.quit(); else this.leave(); };
    $('net-close').onclick = () => this.close();
    $('net').onclick = (e) => { if (e.target === $('net')) this.close(); };
    $('ask-yes').onclick = () => this.answer(true); $('ask-no').onclick = () => this.answer(false);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.view) this.close(); });
    window.addEventListener('pagehide', () => this.game?.close('leave')); // tell the peer at once
    window.addEventListener('hashchange', () => this.fromHash());
    setInterval(() => this.game?.heartbeat(), 1000);
    this.render();
  }

  get phase(): Phase {
    const g = this.game, l = this.link;
    if (!g) return 'idle';
    if (g.closed) return 'closed';
    if (g.ready) return l?.state === 'unstable' ? 'unstable' : 'open';
    if (l?.state === 'waiting') return g.role === 'host' ? 'hosting' : 'joining';
    return 'connecting';
  }
  /** A finished or interrupted session whose game can be offered again. */
  private get resumable() { return this.hooks.active() && !!this.game && (!!this.game.closed || !this.game.ready); }

  // ---------- sessions ----------
  /** Open a room: a new game with `pick` as our side, or the current game resumed. Resolves to the invite link. */
  async host(pick: Side | 'random' | 'resume' = 'random'): Promise<string> {
    const old = pick === 'resume' && this.resumable ? this.game : null;
    this.drop();
    const tok = this.token;
    this.invite = ''; this.error = ''; ($('net-reply') as HTMLInputElement).value = '';
    this.show('invite');
    let r: Awaited<ReturnType<typeof Link.host>>;
    try { r = await Link.host(); }
    catch (e) { if (tok === this.token) { this.error = '无法创建连接：此浏览器可能不支持 WebRTC'; this.render(); } throw e; }
    if (tok !== this.token) { r.link.close(); throw new Error('superseded'); }
    const side: Side = old ? old.side : pick === 'r' || pick === 'b' ? pick : Math.random() < 0.5 ? 'r' : 'b';
    this.attach(r.link, new NetGame(r.link, { role: 'host', side, record: old?.record, game: old?.game, result: old?.result }), tok);
    this.invite = location.origin + location.pathname + '#join=' + r.code;
    this.render();
    return this.invite;
  }
  /** Answer an invite (link or code). Resolves to the reply code for the host. */
  async join(text: string): Promise<string> {
    this.drop();
    const tok = this.token;
    this.reply = ''; this.error = '';
    this.show('guest');
    let r: Awaited<ReturnType<typeof Link.join>>;
    try { r = await Link.join(text); }
    catch (e) { if (tok === this.token) { this.error = e instanceof SdpError ? '邀请链接无效或不完整' : '无法建立连接：此浏览器可能不支持 WebRTC'; this.render(); } throw e; }
    if (tok !== this.token) { r.link.close(); throw new Error('superseded'); }
    this.attach(r.link, new NetGame(r.link, { role: 'guest' }), tok);
    this.reply = r.code;
    this.render();
    return r.code;
  }
  /** Host: apply the guest's reply code. */
  async accept(text: string) {
    const l = this.link;
    if (!l || this.game?.role !== 'host' || this.game.closed) throw new Error('No room to accept into');
    try { await l.accept(text); this.error = ''; }
    catch (e) { this.error = e instanceof SdpError ? '回复码无效，请检查是否完整' : '无法使用此回复码，请重新创建房间'; throw e; }
    finally { this.render(); }
  }
  /** Close the session and forget it. */
  leave() { this.drop(); this.game = null; this.invite = this.reply = this.error = ''; this.close(); this.render(); }
  /** Opening a `#join=` link joins that room. */
  fromHash() {
    const h = location.hash;
    if (!h.startsWith('#join=')) return;
    history.replaceState(null, '', location.pathname + location.search);
    void this.join(h).catch(() => {});
  }

  private drop() {
    this.token++; // callbacks of the old link and game fall silent
    this.game?.close('leave'); this.link?.close(); this.link = null;
    this.prompt(null);
  }
  private attach(link: Link, g: NetGame, tok: number) {
    this.link = link; this.game = g;
    const mine = () => tok === this.token;
    link.onOpen = () => { if (mine()) { g.open(); this.render(); } };
    link.onState = () => { if (mine()) this.render(); };
    g.on = {
      ready: () => { if (!mine()) return; this.close(); this.hooks.begin(); hud.toast(`已连接 · 你执${SIDE[g.side]}`); this.render(); },
      change: (why) => {
        if (!mine() || why === 'move') return; // our own moves are already on the board
        this.hooks.update();
        if (why === 'rematch') hud.toast(`新局 · 你执${SIDE[g.side]}`);
      },
      ask: (k) => { if (mine()) this.prompt(k); },
      lapsed: (k) => { if (this.asking === k) this.prompt(null); },
      answered: (k, yes) => { if (mine() && !yes) hud.toast({ draw: '对方拒绝和棋', undo: '对方拒绝悔棋', rematch: '对方拒绝再战' }[k]); },
      rejected: (why, msg) => console.warn('Refused a message from the peer:', why, msg),
      latency: () => { if (mine()) this.render(); },
      closed: (why) => {
        if (!mine()) return;
        this.prompt(null);
        // Never connected: most likely a network that cannot connect directly.
        this.error = !g.ready && (why === 'timeout' || why === 'failed') ? CLOSED.failed : CLOSED[why] ?? '连接已断开';
        if (why !== 'leave') hud.toast(this.error);
        if (!g.ready && !this.hooks.active()) this.game = null; // nothing to resume: no stale chip
        if (!g.ready && this.view === 'invite') this.view = 'host'; // the invite is spent: offer a new room
        this.hooks.update(); this.render();
      },
    };
  }

  // ---------- in game ----------
  offer(kind: 'draw' | 'undo') {
    const g = this.game;
    if (!g?.ready || g.closed) { hud.toast('未连接'); return; }
    if (g.offer(kind)) hud.toast(kind === 'draw' ? '已提议和棋，等待对方答复' : '已请求悔棋，等待对方答复');
    else hud.toast(g.over ? '对局已结束' : kind === 'draw' ? '请在走子后、对方行棋时求和' : '只能在对方行棋时悔回自己刚走的一步');
  }
  resign() {
    const g = this.game;
    if (!g?.ready || g.closed || g.over) { hud.toast(g?.over ? '对局已结束' : '未连接'); return; }
    if (performance.now() - this.resignArmed > 3000) { this.resignArmed = performance.now(); $('net-resign').textContent = '确认认输'; setTimeout(() => this.render(), 3000); return; }
    this.resignArmed = 0; g.resign(); this.close();
  }
  /** 新局 / 再战一局 in net mode: ask for a rematch once the game is over, else open the card. */
  restart() {
    const g = this.game;
    if (!g?.ready || g.closed || !g.over) { this.open(); return; }
    const asked = g.theirs.rematch !== undefined;
    if (g.rematch()) { if (!asked) hud.toast('已请求再战，等待对方答复'); }
    else if (g.mine.rematch !== undefined) hud.toast('已请求再战，等待对方答复');
  }
  /** Leaving a connected game takes a second tap within three seconds. */
  confirmLeave(): boolean {
    if (this.phase !== 'open' && this.phase !== 'unstable') return true;
    if (performance.now() - this.leaveArmed < 3000) return true;
    this.leaveArmed = performance.now(); hud.toast('再点一次离开联机对局');
    return false;
  }
  private prompt(k: Ask | null) {
    this.asking = k;
    const a = $('ask');
    if (k) a.querySelector('.t')!.textContent = ASK[k];
    a.className = k ? 'show' : '';
  }
  private answer(yes: boolean) {
    const k = this.asking, g = this.game;
    this.prompt(null);
    if (k && g && !g.answer(k, yes)) hud.toast('请求已失效');
  }

  // ---------- card and chip ----------
  /** Open the card where it is useful now; `pick` first offers 本机 / 联机. */
  open(pick = false) {
    const p = this.phase, g = this.game;
    if (p === 'open' || p === 'unstable') this.show('live');
    else if (this.link && g && !g.ready && !g.closed) this.show(g.role === 'host' ? 'invite' : 'guest');
    else this.show(pick && !this.hooks.active() ? 'pick' : 'host');
  }
  get isOpen() { return !!this.view; }
  private show(v: View) { this.view = v; this.render(); }
  close() { this.view = null; this.render(); }
  render() {
    const p = this.phase, g = this.game, v = this.view;
    const card = $('net');
    card.className = v ? 'show ' + v : '';
    ($('net-invite') as HTMLInputElement).value = this.invite;
    ($('net-answer') as HTMLInputElement).value = this.reply;
    $('net-share').style.display = 'share' in navigator && this.invite ? '' : 'none';
    $('net-copy').toggleAttribute('disabled', !this.invite); $('net-copy-reply').toggleAttribute('disabled', !this.reply);
    $('net-accept').toggleAttribute('disabled', !this.invite || p !== 'hosting');
    $('net-resume').style.display = this.resumable && g!.ply ? '' : 'none';
    if (performance.now() - this.resignArmed > 3000) $('net-resign').textContent = '认输';
    $('net-leave').textContent = this.hooks.active() ? '离开联机' : '取消';
    $('net-leave').style.display = this.hooks.active() || (this.link && !g?.closed) ? '' : 'none';
    const hd: Record<View, string> = { pick: '双人对弈', host: '联机对弈', invite: '创建房间', guest: '加入对局', live: '联机对弈' };
    $('net-hd').textContent = v ? hd[v] : '';
    const lat = g && g.latency >= 0 ? ` · 延迟 ${g.latency} ms` : '';
    let status = '';
    if (this.error) status = this.error + (this.resumable && v === 'host' && g!.ply ? ' · 可续弈此局' : '');
    else if (v === 'invite') status = !this.invite ? '正在创建房间…' : p === 'hosting' ? '等待对方的回复码…' : p === 'connecting' ? '连接中…' : '';
    else if (v === 'guest') status = !this.reply ? '正在生成回复码…' : '把回复码发给房主，等待连接…';
    else if (v === 'live' && g) status = `${p === 'unstable' ? '连接不稳' : '已连接'}${lat} · 你执${SIDE[g.side]}`;
    $('net-status').textContent = status;
    // The chip: under the turn line, whenever a session exists or the board is in net mode.
    const chip = $('netchip');
    const text = p === 'open' ? '已连接' + lat : p === 'unstable' || p === 'closed' ? '已断开' : p === 'idle' ? (this.hooks.active() ? '已断开' : '') : '连接中';
    chip.textContent = text; chip.className = text ? 'show ' + p : '';
  }

  /** Debug hook (window.__game.net). */
  debug = {
    host: (pick?: Side | 'random' | 'resume') => this.host(pick ?? 'random'),
    join: (invite: string) => this.join(invite),
    accept: (reply: string) => this.accept(reply),
    send: (m: unknown) => this.link?.send(typeof m === 'string' ? m : JSON.stringify(m)),
    leave: () => { if (this.hooks.active()) this.hooks.quit(); else this.leave(); },
    get state() { return online.state; },
  };
  get state() {
    const g = this.game;
    return { phase: this.phase, role: g?.role ?? null, side: g?.side ?? null, connected: this.phase === 'open', latency: g?.latency ?? -1, ply: g?.ply ?? 0, game: g?.game ?? 0, result: g?.result ?? null, over: g?.over ?? false, record: g?.record ?? '', closed: g?.closed ?? null, strikes: g?.strikes ?? 0, asking: this.asking, mine: { ...g?.mine } };
  }
}

export const online = new Online();
