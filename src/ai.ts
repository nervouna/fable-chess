// Xiangqi search: iterative-deepening alpha-beta with a transposition table and quiescence.
// Self-contained (its own compact board and move generator) so it runs in a Web Worker and in Node.
// Board layout matches the rules engine: index = row * 9 + col, row 0 is black's back rank.
import type { Piece } from './engine';

// Piece codes: type 1..7 = K A B N R C P; +8 for black. Side: 0 = red, 1 = black.
const K = 1, A = 2, B = 3, N = 4, R = 5, C = 6, P = 7;
const TYPE_CODE: Record<string, number> = { K, A, B, N, R, C, P };
const VAL = [0, 10000, 120, 120, 270, 600, 285, 30];
const MATE = 30000, INF = 32000;

/** Playing styles. Balanced is the original evaluation, number for number. */
export type Style = 'balanced' | 'aggressive' | 'solid';
export const STYLES: Style[] = ['balanced', 'aggressive', 'solid'];
/** Penalty the root side sees for a repetition: aggressive refuses draws it is not losing, solid takes them. */
const CONTEMPT: Record<Style, number> = { balanced: 40, aggressive: 110, solid: 0 };

export interface AiRequest {
  board: number[]; turn: 0 | 1;
  /** Hashes of earlier positions in the game (see hashBoard), used to steer away from repetition. */
  reps?: number[];
  timeMs?: number; depth?: number;
  /** Pick at random among near-equal moves (opening variety). */
  variety?: boolean;
  /** Playing style of the side to move (default balanced). */
  style?: Style;
  /** Answer from the opening book when the position is in it (handled by the worker, not search()). */
  book?: boolean;
}
export interface AiResult { from: number; to: number; score: number; depth: number; nodes: number; /** played from the opening book */ book?: boolean }

export const encode = (board: (Piece | null)[]): number[] => board.map((p) => (p ? TYPE_CODE[p.type] + (p.side === 'b' ? 8 : 0) : 0));

// ---------- precomputed geometry ----------
const rowOf = (i: number) => (i / 9) | 0, colOf = (i: number) => i % 9;
const inB = (r: number, c: number) => r >= 0 && r < 10 && c >= 0 && c < 9;
const inPalace = (side: number, r: number, c: number) => c >= 3 && c <= 5 && (side === 0 ? r >= 7 : r <= 2) && r >= 0 && r <= 9;
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const HJ = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0], [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];

const KING_T: number[][][] = [[], []], ADV_T: number[][][] = [[], []];
const ELE_T: number[][][] = [[], []]; // flat [target, eye, ...]
const HORSE_T: number[][] = []; // flat [target, leg, ...]
const HORSE_REV: number[][] = []; // flat [horseSquare, leg, ...] for horses that attack this square
for (let i = 0; i < 90; i++) { HORSE_T.push([]); HORSE_REV.push([]); }
for (let i = 0; i < 90; i++) {
  const r = rowOf(i), c = colOf(i);
  for (let s = 0; s < 2; s++) {
    KING_T[s].push(ORTH.filter(([dr, dc]) => inPalace(s, r + dr, c + dc)).map(([dr, dc]) => (r + dr) * 9 + c + dc));
    ADV_T[s].push(DIAG.filter(([dr, dc]) => inPalace(s, r + dr, c + dc)).map(([dr, dc]) => (r + dr) * 9 + c + dc));
    const e: number[] = [];
    for (const [dr, dc] of DIAG) {
      const rr = r + dr * 2, cc = c + dc * 2;
      if (inB(rr, cc) && (s === 0 ? rr >= 5 : rr <= 4)) e.push(rr * 9 + cc, (r + dr) * 9 + c + dc);
    }
    ELE_T[s].push(e);
  }
  for (const [dr, dc, lr, lc] of HJ) {
    if (!inB(r + dr, c + dc)) continue;
    const t = (r + dr) * 9 + c + dc, leg = (r + lr) * 9 + c + lc;
    HORSE_T[i].push(t, leg); HORSE_REV[t].push(i, leg);
  }
}
const STEP = [-9, 9, -1, 1];
/** Squares left before the edge when stepping in direction d from square i. */
const RUN: number[][] = [];
for (let i = 0; i < 90; i++) RUN.push([rowOf(i), 9 - rowOf(i), colOf(i), 8 - colOf(i)]);

// ---------- piece-square tables (red's point of view, mirrored for black) ----------
const PST: Int16Array[] = [];
for (let code = 0; code < 16; code++) {
  const t = code & 7, side = code >> 3, a = new Int16Array(90);
  if (t) for (let i = 0; i < 90; i++) {
    const rr = side ? rowOf(i) : 9 - rowOf(i), cd = Math.abs(colOf(i) - 4);
    let v = 0;
    if (t === P) v = rr <= 4 ? (rr === 4 ? 6 : 0) + (cd === 0 ? 6 : 0) : rr === 9 ? 30 + (4 - cd) * 2 : 45 + (rr - 5) * 10 + (4 - cd) * 4;
    else if (t === R) v = 8 - cd + (rr >= 5 ? 8 : 0) - (rr === 0 && cd === 4 ? 8 : 0);
    else if (t === N) v = 14 - cd * 3 + Math.min(rr, 7) * 3 - (rr === 0 ? 12 : 0);
    else if (t === C) v = (4 - cd) * 2 + (rr <= 2 ? 6 : 0) + (rr === 2 ? 4 : 0);
    else if (t === A) v = cd === 0 && rr === 1 ? 8 : 0;
    else if (t === B) v = cd === 0 && rr === 2 ? 8 : 0;
    else if (t === K) v = -rr * 12 - cd * 4;
    a[i] = VAL[t] + v;
  }
  PST.push(a);
}

// Style tables: the balanced table plus small deltas. `own` applies to the searching side's pieces,
// `foe` to the opponent's (as the searching side values them). rr: ranks advanced, cd: files from centre.
type Delta = (t: number, rr: number, cd: number) => number;
const STYLE_DELTA: Record<Exclude<Style, 'balanced'>, { own: Delta; foe: Delta }> = {
  // Pieces pressing the enemy palace, crossed pawns and a central cannon; defenders matter less,
  // and the enemy's advisors and elephants are worth taking.
  aggressive: {
    own: (t, rr, cd) =>
      t === R ? (rr >= 5 ? 10 : 0) + (rr >= 7 && cd <= 1 ? 10 : 0)
      : t === N ? (rr >= 5 ? 10 : 0) + (rr >= 6 && rr <= 8 && cd <= 2 ? 12 : 0)
      : t === C ? (cd === 0 ? 8 : 0) + (rr >= 5 ? 4 : 0) + (rr === 9 ? 8 : 0)
      : t === P ? (rr >= 5 ? 10 : 0) + (rr >= 6 && rr <= 8 && cd <= 1 ? 15 : 0)
      : t === A || t === B ? -10 : 0,
    foe: (t) => (t === A || t === B ? 20 : 0),
  },
  // Intact advisors and elephants, the king at home, rooks and horses guarding the river rather than
  // raiding, pawns kept back.
  solid: {
    own: (t, rr, cd) =>
      t === A || t === B ? 25
      : t === K ? (rr === 0 && cd === 0 ? 10 : 0)
      : t === R ? (rr === 4 || rr === 5 ? 8 : 0) - (rr >= 7 ? 8 : 0)
      : t === N ? (rr >= 2 && rr <= 4 ? 6 : 0) - (rr >= 7 ? 8 : 0)
      : t === C ? (rr <= 2 ? 6 : 0)
      : t === P ? (rr >= 5 ? -6 : 0) : 0,
    foe: () => 0,
  },
};
/** Tables per style and searching side: STYLE_PST[style][side][code]. Balanced shares PST itself. */
const STYLE_PST = {} as Record<Style, Int16Array[][]>;
for (const st of STYLES) {
  STYLE_PST[st] = [0, 1].map((me) => PST.map((base, code) => {
    if (st === 'balanced' || !(code & 7)) return base;
    const d = STYLE_DELTA[st], t = code & 7, pside = code >> 3, a = new Int16Array(base);
    for (let i = 0; i < 90; i++) a[i] += (pside === me ? d.own : d.foe)(t, pside ? rowOf(i) : 9 - rowOf(i), Math.abs(colOf(i) - 4));
    return a;
  }));
}
// Style terms on a full army sum to a constant; subtract it so a level game still scores about zero
// (scores stay comparable with contempt and between styles).
const START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'.replace(/\d/g, (d) => '.'.repeat(+d)).replace(/\//g, '');
const STYLE_OFFSET = {} as Record<Style, number[]>;
for (const st of STYLES) STYLE_OFFSET[st] = [0, 1].map((me) => {
  let o = 0;
  for (let i = 0; i < 90; i++) {
    const ch = START[i];
    if (ch === '.') continue;
    const code = TYPE_CODE[ch.toUpperCase()] + (ch === ch.toUpperCase() ? 0 : 8), d = STYLE_PST[st][me][code][i] - PST[code][i];
    o += (code >> 3) === me ? d : -d;
  }
  return o;
});
let pst = PST, contempt = CONTEMPT.balanced;

// ---------- zobrist ----------
let seed = 0x9e3779b9;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) | 0; };
const Z_LO = new Int32Array(16 * 90), Z_HI = new Int32Array(16 * 90);
for (let i = 0; i < 16 * 90; i++) { Z_LO[i] = rnd(); Z_HI[i] = rnd(); }
const Z_TURN_LO = rnd(), Z_TURN_HI = rnd();

/** Hash of an Engine position key (turn letter followed by 90 piece letters). */
export function hashKey(key: string): number {
  const b = new Array<number>(90);
  for (let i = 0; i < 90; i++) { const ch = key[i + 1]; b[i] = ch === '.' ? 0 : TYPE_CODE[ch.toUpperCase()] + (ch === ch.toUpperCase() ? 0 : 8); }
  return hashBoard(b, key[0] === 'b' ? 1 : 0);
}

/** 32-bit position hash, comparable with the hashes the search uses for repetition. */
export function hashBoard(board: number[], turn: number): number {
  let h = turn ? Z_TURN_LO : 0;
  for (let i = 0; i < 90; i++) if (board[i]) h ^= Z_LO[board[i] * 90 + i];
  return h;
}

// ---------- search state ----------
const bd = new Int8Array(90);
const kingSq = [0, 0];
let side = 0, hLo = 0, hHi = 0, score = 0; // score: material + position, red minus black
const TT_BITS = 19, TT_MASK = (1 << TT_BITS) - 1;
const ttKey = new Int32Array(1 << TT_BITS), ttMove = new Int16Array(1 << TT_BITS), ttScore = new Int16Array(1 << TT_BITS);
const ttDepth = new Int8Array(1 << TT_BITS), ttFlag = new Int8Array(1 << TT_BITS); // flag 1 exact, 2 lower, 3 upper
const history = new Int32Array(90 * 90);
const killers = new Int16Array(128 * 2);
const pathHash = new Int32Array(256);
let repCount = new Map<number, number>();
let nodes = 0, deadline = 0, aborted = false;

function setup(board: number[], turn: number, style: Style = 'balanced') {
  pst = STYLE_PST[style][turn]; contempt = CONTEMPT[style];
  hLo = turn ? Z_TURN_LO : 0; hHi = turn ? Z_TURN_HI : 0; score = 0; side = turn;
  for (let i = 0; i < 90; i++) {
    const p = board[i]; bd[i] = p;
    if (!p) continue;
    hLo ^= Z_LO[p * 90 + i]; hHi ^= Z_HI[p * 90 + i];
    score += p < 8 ? pst[p][i] : -pst[p][i];
    if ((p & 7) === K) kingSq[p >> 3] = i;
  }
  const off = STYLE_OFFSET[style][turn];
  score += turn ? off : -off;
}

function make(from: number, to: number): number {
  const p = bd[from], cap = bd[to];
  hLo ^= Z_LO[p * 90 + from] ^ Z_LO[p * 90 + to] ^ Z_TURN_LO; hHi ^= Z_HI[p * 90 + from] ^ Z_HI[p * 90 + to] ^ Z_TURN_HI;
  const d = pst[p][to] - pst[p][from];
  score += p < 8 ? d : -d;
  if (cap) { hLo ^= Z_LO[cap * 90 + to]; hHi ^= Z_HI[cap * 90 + to]; score += cap < 8 ? -pst[cap][to] : pst[cap][to]; }
  bd[to] = p; bd[from] = 0;
  if ((p & 7) === K) kingSq[p >> 3] = to;
  side ^= 1;
  return cap;
}
function unmake(from: number, to: number, cap: number) {
  const p = bd[to];
  side ^= 1;
  bd[from] = p; bd[to] = cap;
  if ((p & 7) === K) kingSq[p >> 3] = from;
  hLo ^= Z_LO[p * 90 + from] ^ Z_LO[p * 90 + to] ^ Z_TURN_LO; hHi ^= Z_HI[p * 90 + from] ^ Z_HI[p * 90 + to] ^ Z_TURN_HI;
  const d = pst[p][to] - pst[p][from];
  score -= p < 8 ? d : -d;
  if (cap) { hLo ^= Z_LO[cap * 90 + to]; hHi ^= Z_HI[cap * 90 + to]; score -= cap < 8 ? -pst[cap][to] : pst[cap][to]; }
}

/** Is `s`'s king attacked (including the flying-general rule)? */
function inCheck(s: number): boolean {
  const k = kingSq[s], foe = (s ^ 1) << 3;
  for (let d = 0; d < 4; d++) {
    const st = STEP[d];
    let n = RUN[k][d], i = k + st;
    while (n > 0 && !bd[i]) { i += st; n--; }
    if (n <= 0) continue;
    const p = bd[i];
    if (p === foe + R || (p === foe + K && d < 2)) return true;
    i += st; n--;
    while (n > 0 && !bd[i]) { i += st; n--; }
    if (n > 0 && bd[i] === foe + C) return true;
  }
  const hr = HORSE_REV[k];
  for (let j = 0; j < hr.length; j += 2) if (bd[hr[j]] === foe + N && !bd[hr[j + 1]]) return true;
  const pw = foe + P, r = rowOf(k), c = colOf(k);
  if (s === 0) { // black pawns move down the board (row + 1)
    if (r > 0 && bd[k - 9] === pw) return true;
    if (r >= 5 && ((c > 0 && bd[k - 1] === pw) || (c < 8 && bd[k + 1] === pw))) return true;
  } else {
    if (r < 9 && bd[k + 9] === pw) return true;
    if (r <= 4 && ((c > 0 && bd[k - 1] === pw) || (c < 8 && bd[k + 1] === pw))) return true;
  }
  return false;
}

/** Pseudo-legal moves for the side to move, encoded as from | to << 7. */
function gen(out: number[], capsOnly: boolean): number {
  let n = 0;
  const mine = side << 3;
  const add = (from: number, to: number) => {
    const t = bd[to];
    if (t ? (t >> 3) !== side : !capsOnly) out[n++] = from | (to << 7);
  };
  for (let i = 0; i < 90; i++) {
    const p = bd[i];
    if (!p || (p & 8) !== mine) continue;
    switch (p & 7) {
      case K: { const t = KING_T[side][i]; for (let j = 0; j < t.length; j++) add(i, t[j]); break; }
      case A: { const t = ADV_T[side][i]; for (let j = 0; j < t.length; j++) add(i, t[j]); break; }
      case B: { const t = ELE_T[side][i]; for (let j = 0; j < t.length; j += 2) if (!bd[t[j + 1]]) add(i, t[j]); break; }
      case N: { const t = HORSE_T[i]; for (let j = 0; j < t.length; j += 2) if (!bd[t[j + 1]]) add(i, t[j]); break; }
      case R:
        for (let d = 0; d < 4; d++) {
          const st = STEP[d];
          let m = RUN[i][d], j = i + st;
          while (m > 0 && !bd[j]) { if (!capsOnly) out[n++] = i | (j << 7); j += st; m--; }
          if (m > 0 && (bd[j] >> 3) !== side) out[n++] = i | (j << 7);
        }
        break;
      case C:
        for (let d = 0; d < 4; d++) {
          const st = STEP[d];
          let m = RUN[i][d], j = i + st;
          while (m > 0 && !bd[j]) { if (!capsOnly) out[n++] = i | (j << 7); j += st; m--; }
          j += st; m--;
          while (m > 0 && !bd[j]) { j += st; m--; }
          if (m > 0 && (bd[j] >> 3) !== side) out[n++] = i | (j << 7);
        }
        break;
      case P: {
        const r = rowOf(i), c = colOf(i);
        if (side === 0) { if (r > 0) add(i, i - 9); if (r <= 4) { if (c > 0) add(i, i - 1); if (c < 8) add(i, i + 1); } }
        else { if (r < 9) add(i, i + 9); if (r >= 5) { if (c > 0) add(i, i - 1); if (c < 8) add(i, i + 1); } }
        break;
      }
    }
  }
  return n;
}

const moveBuf: number[][] = Array.from({ length: 128 }, () => []);
const scoreBuf: number[][] = Array.from({ length: 128 }, () => []);

function order(moves: number[], sc: number[], n: number, ply: number, ttm: number) {
  const k0 = killers[ply * 2], k1 = killers[ply * 2 + 1];
  for (let i = 0; i < n; i++) {
    const m = moves[i], from = m & 127, to = m >> 7, cap = bd[to];
    sc[i] = m === ttm ? 1e9 : cap ? 1e6 + VAL[cap & 7] * 16 - VAL[bd[from] & 7] : m === k0 ? 9e5 : m === k1 ? 8e5 : history[from * 90 + to];
  }
}
/** Selection step: move the best remaining move to position i. */
function pick(moves: number[], sc: number[], i: number, n: number) {
  let b = i;
  for (let j = i + 1; j < n; j++) if (sc[j] > sc[b]) b = j;
  if (b !== i) { const m = moves[i]; moves[i] = moves[b]; moves[b] = m; const s = sc[i]; sc[i] = sc[b]; sc[b] = s; }
}

function repeated(ply: number): boolean {
  for (let i = ply - 2; i >= 0; i -= 2) if (pathHash[i] === hLo) return true;
  return repCount.has(hLo);
}

function quiesce(alpha: number, beta: number, ply: number, qd: number): number {
  nodes++;
  const chk = qd < 3 && inCheck(side);
  let best = -INF;
  if (!chk) {
    best = side === 0 ? score : -score;
    if (best >= beta || qd >= 8 || ply >= 120) return best;
    if (best > alpha) alpha = best;
  }
  const moves = moveBuf[ply], sc = scoreBuf[ply], n = gen(moves, !chk), me = side;
  order(moves, sc, n, ply, 0);
  let legal = 0;
  for (let i = 0; i < n; i++) {
    pick(moves, sc, i, n);
    const m = moves[i], from = m & 127, to = m >> 7;
    const cap = make(from, to);
    if (inCheck(me)) { unmake(from, to, cap); continue; }
    legal++;
    const v = -quiesce(-beta, -alpha, ply + 1, qd + 1);
    unmake(from, to, cap);
    if (v > best) { best = v; if (v > alpha) { alpha = v; if (v >= beta) break; } }
  }
  if (chk && !legal) return -MATE + ply;
  return best;
}

function negamax(depth: number, alpha: number, beta: number, ply: number): number {
  if ((++nodes & 2047) === 0 && deadline && Date.now() > deadline) aborted = true;
  if (aborted) return 0;
  if (ply > 0 && repeated(ply)) return ply & 1 ? contempt : -contempt; // the root player dislikes draws
  const chk = inCheck(side);
  if (chk && ply < 60) depth++;
  if (depth <= 0 || ply >= 100) return quiesce(alpha, beta, ply, 0);
  pathHash[ply] = hLo;

  const slot = hLo & TT_MASK;
  let ttm = 0;
  if (ttKey[slot] === hHi && ttFlag[slot]) {
    ttm = ttMove[slot];
    if (ttDepth[slot] >= depth && ply > 0) {
      let s = ttScore[slot];
      if (s > MATE - 200) s -= ply; else if (s < -MATE + 200) s += ply;
      const f = ttFlag[slot];
      if (f === 1 || (f === 2 && s >= beta) || (f === 3 && s <= alpha)) return s;
    }
  }

  const moves = moveBuf[ply], sc = scoreBuf[ply], n = gen(moves, false), me = side, a0 = alpha;
  order(moves, sc, n, ply, ttm);
  let best = -INF, bestMove = 0, legal = 0;
  for (let i = 0; i < n; i++) {
    pick(moves, sc, i, n);
    const m = moves[i], from = m & 127, to = m >> 7;
    const cap = make(from, to);
    if (inCheck(me)) { unmake(from, to, cap); continue; }
    legal++;
    let v: number;
    if (legal === 1) v = -negamax(depth - 1, -beta, -alpha, ply + 1);
    else {
      // Late quiet moves get a reduced null-window look first.
      const red = legal > 4 && depth >= 3 && !cap && !chk ? 1 : 0;
      v = -negamax(depth - 1 - red, -alpha - 1, -alpha, ply + 1);
      if (v > alpha && (red || v < beta)) v = -negamax(depth - 1, -beta, -alpha, ply + 1);
    }
    unmake(from, to, cap);
    if (aborted) return 0;
    if (v > best) {
      best = v; bestMove = m;
      if (v > alpha) {
        alpha = v;
        if (v >= beta) {
          if (!cap) {
            history[from * 90 + to] += depth * depth;
            if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
          }
          break;
        }
      }
    }
  }
  if (!legal) return -MATE + ply; // checkmate and stalemate both lose in xiangqi
  let s = best;
  if (s > MATE - 200) s += ply; else if (s < -MATE + 200) s -= ply;
  ttKey[slot] = hHi; ttMove[slot] = bestMove; ttScore[slot] = s; ttDepth[slot] = depth; ttFlag[slot] = best <= a0 ? 3 : best >= beta ? 2 : 1;
  return best;
}

function legalRoot(): number[] {
  const tmp: number[] = [], n = gen(tmp, false), me = side, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = tmp[i] & 127, to = tmp[i] >> 7, cap = make(from, to);
    if (!inCheck(me)) out.push(tmp[i]);
    unmake(from, to, cap);
  }
  return out;
}

export function search(req: AiRequest): AiResult | null {
  setup(req.board, req.turn, req.style);
  repCount = new Map();
  for (const h of req.reps ?? []) repCount.set(h, (repCount.get(h) ?? 0) + 1);
  repCount.delete(hLo); // the current position itself is not a repetition yet
  nodes = 0; aborted = false; deadline = 0;
  history.fill(0); killers.fill(0); ttFlag.fill(0);
  const root = legalRoot();
  if (!root.length) return null;
  const maxDepth = req.depth ?? 32;
  const rootScore = new Map<number, number>();
  let best = root[0], bestScore = 0, done = 0;

  if (req.variety) { // exact shallow scores for every move, then choose among the near-best
    pathHash[0] = hLo;
    for (const m of root) { const cap = make(m & 127, m >> 7); rootScore.set(m, -negamax(2, -INF, INF, 1)); unmake(m & 127, m >> 7, cap); }
    const top = Math.max(...rootScore.values()), pool = root.filter((m) => rootScore.get(m)! >= top - 22);
    best = pool[(Math.random() * pool.length) | 0];
    return { from: best & 127, to: best >> 7, score: rootScore.get(best)!, depth: 3, nodes };
  }

  if (req.timeMs) deadline = Date.now() + req.timeMs;
  for (let d = 1; d <= maxDepth; d++) {
    root.sort((a, b) => (rootScore.get(b) ?? -INF) - (rootScore.get(a) ?? -INF));
    let alpha = -INF, itBest = root[0];
    pathHash[0] = hLo;
    for (let i = 0; i < root.length; i++) {
      const m = root[i], from = m & 127, to = m >> 7, cap = make(from, to);
      let v: number;
      if (i === 0) v = -negamax(d - 1, -INF, -alpha, 1);
      else { v = -negamax(d - 1, -alpha - 1, -alpha, 1); if (v > alpha && !aborted) v = -negamax(d - 1, -INF, -alpha, 1); }
      unmake(from, to, cap);
      if (aborted) break;
      rootScore.set(m, v > alpha ? v : alpha - 1);
      if (v > alpha) { alpha = v; itBest = m; }
    }
    if (aborted) { if (itBest !== root[0] && alpha > -INF) { best = itBest; bestScore = alpha; } break; }
    best = itBest; bestScore = alpha; done = d;
    if (Math.abs(bestScore) > MATE - 200 || root.length === 1) break; // forced line found
  }
  return { from: best & 127, to: best >> 7, score: bestScore, depth: done, nodes };
}

/** Legal moves of a position as [from, to] pairs. */
export function legalPairs(board: number[], turn: number): [number, number][] {
  setup(board, turn);
  return legalRoot().map((m) => [m & 127, m >> 7]);
}

/** Legal move count to `depth`, for checking the generator against the rules engine. */
export function perft(board: number[], turn: number, depth: number): number {
  setup(board, turn);
  const rec = (d: number, ply: number): number => {
    const moves = moveBuf[ply], n = gen(moves, false), me = side;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const from = moves[i] & 127, to = moves[i] >> 7, cap = make(from, to);
      if (!inCheck(me)) c += d === 1 ? 1 : rec(d - 1, ply + 1);
      unmake(from, to, cap);
    }
    return c;
  };
  return rec(depth, 0);
}
