// Pure xiangqi rules engine. No rendering dependencies; runs in Node for tests.
// Board: 10 rows x 9 cols, index = row * 9 + col. Row 0 is black's back rank, row 9 is red's.

export type Side = 'r' | 'b';
export type PType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P';
export interface Piece { id: number; side: Side; type: PType }
export interface Move { from: number; to: number; piece: Piece; captured: Piece | null; notation: string; /** the move gives check */ check: boolean }
export type EndReason = 'checkmate' | 'stalemate' | 'perpetual' | 'repetition' | 'nocapture';
/** `winner` is null for a draw (repetition without perpetual check, or too long without a capture). */
export interface Status { check: boolean; over: boolean; winner: Side | null; reason: EndReason | null }
export const REPETITION_LIMIT = 3, NO_CAPTURE_LIMIT = 120;

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

export const rowOf = (i: number) => (i / 9) | 0;
export const colOf = (i: number) => i % 9;
export const idx = (r: number, c: number) => r * 9 + c;
export const other = (s: Side): Side => (s === 'r' ? 'b' : 'r');

const NAMES: Record<Side, Record<PType, string>> = {
  r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
};
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
// Horse: [dr, dc, legDr, legDc]
const HORSE = [
  [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
  [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
];

const inBoard = (r: number, c: number) => r >= 0 && r < 10 && c >= 0 && c < 9;
const inPalace = (s: Side, r: number, c: number) =>
  c >= 3 && c <= 5 && (s === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2);

export class Engine {
  board: (Piece | null)[] = new Array(90).fill(null);
  turn: Side = 'r';
  history: Move[] = [];
  /** Position key after each move (keys[0] is the starting position), for repetition detection. */
  keys: string[] = [];

  constructor(fen: string = START_FEN) { this.load(fen); }

  load(fen: string) {
    this.board.fill(null);
    this.history = [];
    const [rows, turn] = fen.trim().split(/\s+/);
    let id = 0;
    rows.split('/').forEach((line, r) => {
      let c = 0;
      for (const ch of line) {
        if (/\d/.test(ch)) { c += +ch; continue; }
        const up = ch.toUpperCase();
        const type = (up === 'E' ? 'B' : up === 'H' ? 'N' : up) as PType;
        this.board[idx(r, c)] = { id: id++, side: ch === up ? 'r' : 'b', type };
        c++;
      }
    });
    this.turn = turn === 'b' ? 'b' : 'r';
    this.keys = [this.key()];
  }

  key(): string {
    let s = this.turn as string;
    for (const p of this.board) s += p ? (p.side === 'r' ? p.type : p.type.toLowerCase()) : '.';
    return s;
  }

  /** Pseudo-legal destinations for the piece on square i (ignores self-check). */
  private gen(i: number, out: number[]) {
    const p = this.board[i]!;
    const b = this.board;
    const r = rowOf(i), c = colOf(i);
    const tryAdd = (rr: number, cc: number) => {
      if (!inBoard(rr, cc)) return;
      const t = b[idx(rr, cc)];
      if (!t || t.side !== p.side) out.push(idx(rr, cc));
    };
    switch (p.type) {
      case 'K':
        for (const [dr, dc] of ORTH) if (inPalace(p.side, r + dr, c + dc)) tryAdd(r + dr, c + dc);
        break;
      case 'A':
        for (const [dr, dc] of DIAG) if (inPalace(p.side, r + dr, c + dc)) tryAdd(r + dr, c + dc);
        break;
      case 'B':
        for (const [dr, dc] of DIAG) {
          const rr = r + dr * 2, cc = c + dc * 2;
          if (!inBoard(rr, cc)) continue;
          if (p.side === 'r' ? rr < 5 : rr > 4) continue; // cannot cross the river
          if (b[idx(r + dr, c + dc)]) continue; // blocked eye
          tryAdd(rr, cc);
        }
        break;
      case 'N':
        for (const [dr, dc, lr, lc] of HORSE) {
          if (!inBoard(r + dr, c + dc)) continue;
          if (b[idx(r + lr, c + lc)]) continue; // hobbled leg
          tryAdd(r + dr, c + dc);
        }
        break;
      case 'R':
        for (const [dr, dc] of ORTH) {
          let rr = r + dr, cc = c + dc;
          while (inBoard(rr, cc)) {
            const t = b[idx(rr, cc)];
            if (!t) out.push(idx(rr, cc));
            else { if (t.side !== p.side) out.push(idx(rr, cc)); break; }
            rr += dr; cc += dc;
          }
        }
        break;
      case 'C':
        for (const [dr, dc] of ORTH) {
          let rr = r + dr, cc = c + dc;
          while (inBoard(rr, cc) && !b[idx(rr, cc)]) { out.push(idx(rr, cc)); rr += dr; cc += dc; }
          rr += dr; cc += dc; // hop over the screen
          while (inBoard(rr, cc)) {
            const t = b[idx(rr, cc)];
            if (t) { if (t.side !== p.side) out.push(idx(rr, cc)); break; }
            rr += dr; cc += dc;
          }
        }
        break;
      case 'P': {
        const f = p.side === 'r' ? -1 : 1;
        tryAdd(r + f, c);
        if (p.side === 'r' ? r <= 4 : r >= 5) { tryAdd(r, c - 1); tryAdd(r, c + 1); }
        break;
      }
    }
  }

  kingSquare(side: Side): number {
    for (let i = 0; i < 90; i++) { const p = this.board[i]; if (p && p.type === 'K' && p.side === side) return i; }
    return -1;
  }

  inCheck(side: Side): boolean {
    const k = this.kingSquare(side);
    if (k < 0) return true;
    const tmp: number[] = [];
    for (let i = 0; i < 90; i++) {
      const p = this.board[i];
      if (!p || p.side === side) continue;
      tmp.length = 0;
      this.gen(i, tmp);
      if (tmp.includes(k)) return true;
    }
    // Flying general: kings may not face each other on an open file.
    const ek = this.kingSquare(other(side));
    if (ek >= 0 && colOf(ek) === colOf(k)) {
      const lo = Math.min(k, ek), hi = Math.max(k, ek);
      let blocked = false;
      for (let i = lo + 9; i < hi; i += 9) if (this.board[i]) { blocked = true; break; }
      if (!blocked) return true;
    }
    return false;
  }

  /** Legal destinations for the piece on square i. */
  legalFrom(i: number): number[] {
    const p = this.board[i];
    if (!p) return [];
    const cand: number[] = [];
    this.gen(i, cand);
    const b = this.board;
    return cand.filter((to) => {
      const cap = b[to];
      b[to] = p; b[i] = null;
      const ok = !this.inCheck(p.side);
      b[i] = p; b[to] = cap;
      return ok;
    });
  }

  legalMoves(side: Side = this.turn): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    for (let i = 0; i < 90; i++) {
      const p = this.board[i];
      if (p && p.side === side) for (const to of this.legalFrom(i)) out.push({ from: i, to });
    }
    return out;
  }

  /** Play a move for the side to move. Returns null if illegal. */
  move(from: number, to: number): Move | null {
    const p = this.board[from];
    if (!p || p.side !== this.turn || !this.legalFrom(from).includes(to)) return null;
    const m: Move = { from, to, piece: p, captured: this.board[to], notation: this.notate(from, to), check: false };
    this.board[to] = p; this.board[from] = null;
    this.turn = other(this.turn);
    m.check = this.inCheck(this.turn);
    this.history.push(m); this.keys.push(this.key());
    return m;
  }

  undo(): Move | null {
    const m = this.history.pop();
    if (!m) return null;
    this.keys.pop();
    this.board[m.from] = m.piece; this.board[m.to] = m.captured;
    this.turn = m.piece.side;
    return m;
  }

  status(): Status {
    const check = this.inCheck(this.turn);
    if (this.legalMoves().length === 0) return { check, over: true, winner: other(this.turn), reason: check ? 'checkmate' : 'stalemate' };
    // Repetition: a side that repeats only by checking loses; otherwise it is a draw.
    const n = this.history.length, cur = this.keys[n];
    let seen = 0, prev = -1;
    for (let i = n; i >= 0; i--) if (this.keys[i] === cur) { seen++; if (seen === 2) prev = i; }
    if (seen >= REPETITION_LIMIT) {
      const all = (s: Side) => { const ms = this.history.slice(prev).filter((m) => m.piece.side === s); return ms.length > 0 && ms.every((m) => m.check); };
      const r = all('r'), b = all('b');
      if (r !== b) return { check, over: true, winner: r ? 'b' : 'r', reason: 'perpetual' };
      return { check, over: true, winner: null, reason: 'repetition' };
    }
    let quiet = 0;
    for (let i = n - 1; i >= 0 && !this.history[i].captured; i--) quiet++;
    if (quiet >= NO_CAPTURE_LIMIT) return { check, over: true, winner: null, reason: 'nocapture' };
    return { check, over: false, winner: null, reason: null };
  }

  /** Traditional Chinese move notation, e.g. 炮二平五. Must be called before the move is applied. */
  notate(from: number, to: number): string {
    const p = this.board[from]!;
    const red = p.side === 'r';
    const fr = rowOf(from), fc = colOf(from), tr = rowOf(to), tc = colOf(to);
    const fileNo = (c: number) => (red ? CN_NUM[8 - c] : String(c + 1));
    const num = (n: number) => (red ? CN_NUM[n - 1] : String(n));
    let head = NAMES[p.side][p.type] + fileNo(fc);
    if (p.type !== 'K' && p.type !== 'A' && p.type !== 'B') {
      // Same-type pieces sharing a file are told apart front (closer to the enemy) to back: 前/后, 前/中/后
      // for three pawns, 一二三四五 for more. When two files each hold several pawns, the pawns on both are
      // numbered 一二三… together: files in the side's own order (file 一/1 first), each front to back.
      // (Advisors and elephants need no tag: on a shared file only one can advance and one retreat.)
      const files = stacks(this.board, p.side, p.type), own = files.get(fc)!;
      if (own.length > 1) {
        const multi = [...files.keys()].filter((c) => files.get(c)!.length > 1).sort((a, b) => (red ? b - a : a - b));
        const k = own.indexOf(fr), n = own.length;
        const tag = multi.length > 1 ? CN_NUM[multi.flatMap((c) => files.get(c)!.map((r) => c * 10 + r)).indexOf(fc * 10 + fr)]
          : n === 2 ? ['前', '后'][k] : n === 3 ? ['前', '中', '后'][k] : CN_NUM[k];
        head = tag + NAMES[p.side][p.type];
      }
    }
    if (tr === fr) return head + '平' + fileNo(tc);
    const forward = red ? tr < fr : tr > fr;
    const straight = fc === tc;
    return head + (forward ? '进' : '退') + (straight ? num(Math.abs(tr - fr)) : fileNo(tc));
  }

  perft(depth: number): number {
    if (depth === 0) return 1;
    let n = 0;
    for (const { from, to } of this.legalMoves()) {
      const p = this.board[from]!, cap = this.board[to];
      this.board[to] = p; this.board[from] = null; this.turn = other(this.turn);
      n += this.perft(depth - 1);
      this.turn = other(this.turn); this.board[from] = p; this.board[to] = cap;
    }
    return n;
  }
}

/** Rows of `side`'s pieces of `type`, by file (column), each list front (nearest the enemy) first. */
export function stacks(board: (Piece | null)[], side: Side, type: PType): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let k = 0; k < 10; k++) {
    const r = side === 'r' ? k : 9 - k; // red advances toward row 0, black toward row 9
    for (let c = 0; c < 9; c++) {
      const q = board[idx(r, c)];
      if (q && q.side === side && q.type === type) out.set(c, [...(out.get(c) ?? []), r]);
    }
  }
  return out;
}

/** UCCI-style square: file a-i, rank 0-9 counted from red's back rank. */
export function sq(s: string): number { return idx(9 - +s[1], s.charCodeAt(0) - 97); }
export function sqName(i: number): string { return String.fromCharCode(97 + colOf(i)) + (9 - rowOf(i)); }
