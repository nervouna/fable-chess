// Online play protocol: one endpoint of a game between two peers over an ordered, reliable channel.
// Pure (no DOM, no WebRTC), so tests run two endpoints over an in-memory transport.
//
// Each endpoint keeps its own Engine for the session and trusts nothing from the peer: every message
// is size- and rate-limited, parsed defensively and checked against that engine (game number, ply,
// side to move, legality). A bad message never changes state; one that suggests the two sides
// disagree triggers a resync. The host is the authority: it sends `sync` with its record, the guest
// asks for one with `sync-request`. Too many bad messages or resyncs end the session.
//
// Messages (small JSON objects, `t` names the type):
//   hello {v, side?, game?, record?, end?}  host first (the guest's side and the game to play or
//                                            resume), the guest answers with {v}
//   move {g, ply, from, to}                  ply = moves played before it; squares 0..89
//   resign {g}
//   draw-offer / draw-accept / draw-decline {g, ply}
//   undo-request / undo-accept / undo-decline {g, ply}   take back the requester's last move
//   rematch / rematch-accept / rematch-decline {game}     the next game, colours swapped
//   sync {game, side, record, end?} · sync-request · ping {n} · pong {n} · bye {why?}
// Offers (draw, undo) are made on the opponent's turn and lapse with the next move, so an answer can
// never cross a move. Rematch requests that cross count as agreement.
import { Engine, START_FEN, other, type EndReason, type Side } from './engine.ts';
import { decode, encode } from './record.ts';

export const PROTOCOL = 1;
/** Largest message accepted, in characters (a sync of a very long game stays far below). */
export const MAX_MESSAGE = 4096;
/** Rate limit: a bucket of this many messages, refilled at RATE per second. */
const BURST = 40, RATE = 20;
const MAX_STRIKES = 30, MAX_RESYNCS = 12;
export const PING_EVERY = 2000, TIMEOUT = 15000;

export type Role = 'host' | 'guest';
export type Ask = 'draw' | 'undo' | 'rematch';
export interface Result { winner: Side | null; reason: EndReason | 'resign' | 'draw' }
/** A message pipe. The endpoint sets the two callbacks. */
export interface Transport { send(text: string): void; close(): void; onMessage: ((data: unknown) => void) | null; onClose: ((why: string) => void) | null }
export interface NetEvents {
  /** hello exchanged: the session's game (new or resumed) is set */
  ready?(): void;
  /** the session's game changed: a move (either side's), an undo, a resync, a rematch, a resignation or a draw */
  change?(why: 'move' | 'remote' | 'undo' | 'sync' | 'rematch' | 'end'): void;
  /** the peer asks something; `lapsed` withdraws a question no longer valid */
  ask?(kind: Ask): void;
  lapsed?(kind: Ask): void;
  /** the peer answered one of our questions */
  answered?(kind: Ask, yes: boolean): void;
  rejected?(why: string, msg: string): void;
  latency?(ms: number): void;
  closed?(why: string): void;
}
export interface Options { role: Role; /** our side (host: chosen; guest: set by hello) */ side?: Side; record?: string; game?: number; result?: Result | null; now?: () => number }

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isSide = (v: unknown): v is Side => v === 'r' || v === 'b';
const REASONS = ['checkmate', 'stalemate', 'perpetual', 'repetition', 'nocapture', 'resign', 'draw'];
function readResult(v: unknown): Result | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return (o.w === null || isSide(o.w)) && typeof o.why === 'string' && REASONS.includes(o.why) ? { winner: o.w as Side | null, reason: o.why as Result['reason'] } : undefined;
}
const writeResult = (r: Result | null) => (r ? { w: r.winner, why: r.reason } : undefined);

export class NetGame {
  readonly role: Role;
  side: Side;
  engine = new Engine();
  game: number;
  /** a result agreed outside the rules (resignation, draw); rules endings come from engine.status() */
  result: Result | null;
  /** hello exchanged */
  ready = false;
  /** why the session ended, once it has */
  closed: string | null = null;
  latency = -1;
  on: NetEvents = {};
  /** our open questions: the ply (draw, undo) or the game number (rematch) asked at */
  mine: Partial<Record<Ask, number>> = {};
  /** the peer's open questions */
  theirs: Partial<Record<Ask, number>> = {};
  strikes = 0; resyncs = 0;
  private t: Transport;
  private now: () => number;
  private tokens = BURST; private filled: number; private heard: number;
  private opened = false; private pingN = 0; private pingAt = 0; private pinged = 0; private lastSync = -1e9;

  constructor(t: Transport, o: Options) {
    this.t = t; this.role = o.role; this.now = o.now ?? (() => Date.now());
    this.side = o.side ?? 'b'; this.game = o.game ?? 0; this.result = o.result ?? null;
    if (o.record) this.engine = decode(o.record).engine;
    this.filled = this.heard = this.now();
    t.onMessage = (d) => this.receive(d);
    t.onClose = (why) => this.close(why, false);
  }

  get peer(): Side { return other(this.side); }
  get ply() { return this.engine.history.length; }
  /** The game has ended, by the rules or by agreement. */
  get over() { return !!this.result || this.engine.status().over; }
  /** Our move to make, nothing pending. */
  get myTurn() { return this.ready && !this.closed && !this.over && this.engine.turn === this.side; }
  /** The record of the session's game, as in `#g=` links. */
  get record() { return encode(this.engine); }

  /** The channel is open: the host introduces the game. */
  open() {
    this.heard = this.now(); this.opened = true;
    if (this.role === 'host') this.send({ t: 'hello', v: PROTOCOL, side: this.peer, game: this.game, record: this.record, end: writeResult(this.result) });
  }

  // ---------- local actions (each returns false when not allowed now) ----------
  move(from: number, to: number): boolean {
    if (!this.myTurn || !this.engine.move(from, to)) return false;
    this.lapse();
    this.send({ t: 'move', g: this.game, ply: this.ply - 1, from, to });
    this.on.change?.('move');
    return true;
  }
  resign(): boolean {
    if (!this.live || this.over) return false;
    this.result = { winner: this.peer, reason: 'resign' }; this.lapse();
    this.send({ t: 'resign', g: this.game });
    this.on.change?.('end');
    return true;
  }
  /** Offer a draw or ask to take back our last move: only while the opponent is to move. */
  offer(kind: 'draw' | 'undo'): boolean {
    if (!this.live || this.over || this.engine.turn === this.side || this.mine[kind] !== undefined || (kind === 'undo' && !this.ply)) return false;
    this.mine[kind] = this.ply;
    this.send({ t: kind === 'draw' ? 'draw-offer' : 'undo-request', g: this.game, ply: this.ply });
    return true;
  }
  /** Ask for (or, when the peer already asked, agree to) the next game with colours swapped. */
  rematch(): boolean {
    if (this.theirs.rematch !== undefined) return this.answer('rematch', true);
    if (!this.live || !this.over || this.mine.rematch !== undefined) return false;
    this.mine.rematch = this.game + 1;
    this.send({ t: 'rematch', game: this.game + 1 });
    return true;
  }
  answer(kind: Ask, yes: boolean): boolean {
    const at = this.theirs[kind];
    if (!this.live || at === undefined) return false;
    delete this.theirs[kind];
    if (kind === 'rematch') {
      this.send({ t: yes ? 'rematch-accept' : 'rematch-decline', game: at });
      if (yes) this.newGame();
      return true;
    }
    this.send({ t: `${kind}-${yes ? 'accept' : 'decline'}`, g: this.game, ply: at });
    if (!yes) return true;
    if (kind === 'draw') { this.result = { winner: null, reason: 'draw' }; this.lapse(); this.on.change?.('end'); }
    else { this.engine.undo(); this.lapse(); this.on.change?.('undo'); }
    return true;
  }

  /** Call about once a second: sends pings, measures latency, gives up on a silent peer. */
  heartbeat() {
    if (this.closed || !this.opened) return;
    const now = this.now();
    if (now - this.heard > TIMEOUT) { this.close('timeout', false); return; }
    if (now - this.pinged >= PING_EVERY) { this.pinged = this.pingAt = now; this.send({ t: 'ping', n: ++this.pingN }); }
  }
  /** End the session; `tell` sends a goodbye first. */
  close(why = 'leave', tell = true) {
    if (this.closed) return;
    this.closed = why; this.opened = false;
    this.t.onMessage = this.t.onClose = null; // the transport's own close must not re-enter
    if (tell) this.t.send(JSON.stringify({ t: 'bye', why }));
    this.t.close();
    this.on.closed?.(why);
  }

  // ---------- incoming ----------
  receive(data: unknown) {
    if (this.closed) return;
    if (typeof data !== 'string') return this.reject('not text', '');
    if (data.length > MAX_MESSAGE) return this.reject('too large', data.slice(0, 80));
    const now = this.now();
    this.tokens = Math.min(BURST, this.tokens + ((now - this.filled) / 1000) * RATE); this.filled = now;
    if (this.tokens < 1) return this.reject('rate', data.slice(0, 80));
    this.tokens--;
    let m: Record<string, unknown>;
    try { m = JSON.parse(data); } catch { return this.reject('not JSON', data.slice(0, 80)); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return this.reject('not a message', data.slice(0, 80));
    this.heard = now;
    const bad = (why: string, resync = false) => this.reject(why, data.slice(0, 80), resync);
    switch (m.t) {
      case 'ping': if (isInt(m.n, 0, 1e9)) this.send({ t: 'pong', n: m.n }); return;
      case 'pong':
        if (m.n === this.pingN && this.pingAt) { this.latency = Math.max(0, Math.round(now - this.pingAt)); this.pingAt = 0; this.on.latency?.(this.latency); }
        return;
      case 'bye': this.close(m.why === 'version' ? 'version' : 'bye', false); return;
      case 'hello': return this.hello(m, bad);
    }
    if (!this.ready) return bad('before hello');
    const g = m.g, ply = m.ply;
    switch (m.t) {
      case 'move': {
        if (g !== this.game || !isInt(ply, 0, 9999) || !isInt(m.from, 0, 89) || !isInt(m.to, 0, 89)) return bad('bad move fields', true);
        if (this.over) return bad('move after the end', true);
        if (this.engine.turn !== this.peer) return bad('move out of turn', true);
        if (ply !== this.ply) return bad(`move for ply ${ply}, at ${this.ply}`, true);
        if (!this.engine.move(m.from, m.to)) return bad('illegal move', true);
        this.lapse();
        this.on.change?.('remote');
        return;
      }
      case 'resign':
        if (g !== this.game || this.over) return bad('resign out of place', true);
        this.result = { winner: this.side, reason: 'resign' }; this.lapse();
        this.on.change?.('end');
        return;
      case 'draw-offer': case 'undo-request': {
        const kind = m.t === 'draw-offer' ? 'draw' : 'undo';
        if (g !== this.game || ply !== this.ply || this.over || this.engine.turn !== this.side || (kind === 'undo' && !this.ply)) return bad(`${m.t} out of place`, true);
        if (this.theirs[kind] !== undefined) return bad(`repeated ${m.t}`);
        this.theirs[kind] = this.ply; this.on.ask?.(kind);
        return;
      }
      case 'draw-accept': case 'undo-accept': {
        const kind = m.t === 'draw-accept' ? 'draw' : 'undo';
        if (g !== this.game || ply !== this.ply || this.mine[kind] !== ply || this.over) return bad(`${m.t} without an offer`, true);
        delete this.mine[kind];
        if (kind === 'draw') this.result = { winner: null, reason: 'draw' };
        else this.engine.undo();
        this.lapse();
        this.on.answered?.(kind, true); this.on.change?.(kind === 'draw' ? 'end' : 'undo');
        return;
      }
      case 'draw-decline': case 'undo-decline': {
        const kind = m.t === 'draw-decline' ? 'draw' : 'undo';
        if (g === this.game && this.mine[kind] === ply) { delete this.mine[kind]; this.on.answered?.(kind, false); }
        return; // a decline that crossed a move is harmless
      }
      case 'rematch':
        if (m.game !== this.game + 1 || !this.over) return bad('rematch out of place', true);
        if (this.mine.rematch === m.game) { this.newGame(); return; } // both asked: agreed
        if (this.theirs.rematch !== undefined) return bad('repeated rematch');
        this.theirs.rematch = m.game; this.on.ask?.('rematch');
        return;
      case 'rematch-accept':
        if (m.game === this.game && this.mine.rematch === undefined) return; // our requests crossed and we already began
        if (m.game !== this.game + 1 || this.mine.rematch !== m.game) return bad('rematch-accept without a request', true);
        this.on.answered?.('rematch', true); this.newGame();
        return;
      case 'rematch-decline':
        if (this.mine.rematch === m.game) { delete this.mine.rematch; this.on.answered?.('rematch', false); }
        return;
      case 'sync-request':
        if (this.role !== 'host') return bad('sync-request to a guest');
        if (now - this.lastSync < 300) return; // just sent one (decode replays the game: keep it rare)
        this.sendSync();
        return;
      case 'sync': {
        if (this.role !== 'guest') return bad('sync to the host');
        const end = readResult(m.end);
        if (!isInt(m.game, 0, 1e6) || !isSide(m.side) || typeof m.record !== 'string' || end === undefined) return bad('bad sync fields');
        let e: Engine;
        try { e = decode(m.record).engine; } catch { return bad('bad sync record'); }
        this.engine = e; this.game = m.game; this.side = m.side; this.result = end; this.mine = {}; this.dropTheirs();
        this.on.change?.('sync');
        return;
      }
    }
    bad('unknown type');
  }

  private hello(m: Record<string, unknown>, bad: (why: string, resync?: boolean) => void) {
    if (m.v !== PROTOCOL) { this.close('version', true); return; }
    if (this.ready) return bad('repeated hello');
    if (this.role === 'guest') {
      const end = readResult(m.end);
      if (!isSide(m.side) || !isInt(m.game, 0, 1e6) || typeof m.record !== 'string' || end === undefined) return bad('bad hello');
      try { this.engine = decode(m.record).engine; } catch { return bad('bad hello record'); }
      this.side = m.side; this.game = m.game; this.result = end;
      this.send({ t: 'hello', v: PROTOCOL });
    }
    this.ready = true;
    this.on.ready?.();
  }

  /** Refuse a message; a sign of disagreement asks for (guest) or sends (host) the authoritative game. */
  private reject(why: string, msg: string, resync = false) {
    this.on.rejected?.(why, msg);
    if (++this.strikes > MAX_STRIKES) { this.close('abuse', true); return; }
    if (!resync || !this.ready) return;
    if (++this.resyncs > MAX_RESYNCS) { this.close('desync', true); return; }
    if (this.role === 'host') this.sendSync(); else this.send({ t: 'sync-request' });
  }
  private sendSync() { this.lastSync = this.now(); this.send({ t: 'sync', game: this.game, side: this.peer, record: this.record, end: writeResult(this.result) }); }
  private send(m: object) { if (!this.closed) this.t.send(JSON.stringify(m)); }
  private get live() { return this.ready && !this.closed; }
  /** A move or an ending voids open draw and undo questions both ways. */
  private lapse() {
    delete this.mine.draw; delete this.mine.undo;
    for (const k of ['draw', 'undo'] as const) if (this.theirs[k] !== undefined) { delete this.theirs[k]; this.on.lapsed?.(k); }
  }
  private dropTheirs() { for (const k of Object.keys(this.theirs) as Ask[]) { delete this.theirs[k]; this.on.lapsed?.(k); } }
  private newGame() {
    this.game++; this.side = this.peer; this.engine = new Engine(START_FEN); this.result = null;
    this.mine = {}; this.dropTheirs();
    this.on.change?.('rematch');
  }
}

/** Two connected in-memory transports. Delivery is synchronous and in order, unless `hold` is set,
 *  in which case messages wait until `flush()` (to let tests cross messages in flight). */
export class MemoryTransport implements Transport {
  onMessage: ((data: unknown) => void) | null = null;
  onClose: ((why: string) => void) | null = null;
  peer!: MemoryTransport;
  inbox: unknown[] = [];
  hold = false; closed = false; sent = 0;
  private flushing = false;
  static pair(): [MemoryTransport, MemoryTransport] { const a = new MemoryTransport(), b = new MemoryTransport(); a.peer = b; b.peer = a; return [a, b]; }
  send(text: unknown) { if (this.closed || this.peer.closed) return; this.sent++; this.peer.inbox.push(text); if (!this.peer.hold) this.peer.flush(); }
  flush() {
    if (this.flushing) return;
    this.flushing = true;
    while (this.inbox.length && !this.closed) this.onMessage?.(this.inbox.shift());
    this.flushing = false;
  }
  close() { if (this.closed) return; this.closed = true; this.inbox = []; const p = this.peer; if (!p.closed) { p.closed = true; p.onClose?.('lost'); } }
}
