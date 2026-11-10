// Game records. Two text forms of the same thing, a start position plus the moves:
//   compact  `1.<moves>` or `1~<fen>.<moves>`: for links. Each ply is its index among the legal moves
//            of that position (sorted by from * 90 + to) in base64url: one character while there are
//            at most 64 legal moves, two otherwise. The FEN (only for a non-standard start) has its
//            space written as `_`. About one character per ply, so a 100-ply game fits in ~105.
//   readable ICCS coordinates (h2e2) numbered in pairs, with the traditional notation alongside.
// Decoding accepts either (or a whole link) and replays every move through the rules engine.
import { Engine, START_FEN, idx, sq, sqName, type Piece, type Side, type Status } from './engine.ts';

export const RECORD_VERSION = '1';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface Ply { from: number; to: number }
export interface GameRecord { fen: string; moves: Ply[]; /** the game played out to its last move */ engine: Engine }
export class RecordError extends Error {}

const LETTER: Record<string, string> = { K: 'k', A: 'a', B: 'b', N: 'n', R: 'r', C: 'c', P: 'p' };
/** FEN of a board, red to move written as `w`. */
export function fenOf(board: (Piece | null)[], turn: Side): string {
  const rows: string[] = [];
  for (let r = 0; r < 10; r++) {
    let s = '', gap = 0;
    for (let c = 0; c < 9; c++) {
      const p = board[idx(r, c)];
      if (!p) { gap++; continue; }
      if (gap) { s += gap; gap = 0; }
      s += p.side === 'r' ? p.type : LETTER[p.type];
    }
    rows.push(s + (gap || ''));
  }
  return rows.join('/') + (turn === 'r' ? ' w' : ' b');
}

/** The position the game started from, found by unwinding its history. */
export function startFen(e: Engine): string {
  const b = e.board.slice();
  let turn = e.turn;
  for (let i = e.history.length - 1; i >= 0; i--) { const m = e.history[i]; b[m.from] = m.piece; b[m.to] = m.captured; turn = m.piece.side; }
  return fenOf(b, turn);
}

/** Check a FEN strictly (Engine.load accepts anything) and return it normalised. */
export function checkFen(fen: string): string {
  const [rows, turn = 'w', ...rest] = fen.trim().split(/\s+/);
  if (rest.length > 4 || !/^[wrb]$/.test(turn)) throw new RecordError(`Bad side to move in FEN "${fen}"`);
  const lines = rows.split('/');
  if (lines.length !== 10) throw new RecordError(`FEN needs 10 ranks, got ${lines.length}`);
  const kings = { r: 0, b: 0 };
  lines.forEach((line, r) => {
    let n = 0;
    for (const ch of line) {
      if (/[1-9]/.test(ch)) { n += +ch; continue; }
      if (!/[kabenrhcpKABENRHCP]/.test(ch)) throw new RecordError(`Unknown piece "${ch}" in FEN`);
      if (ch === 'K') kings.r++; else if (ch === 'k') kings.b++;
      n++;
    }
    if (n !== 9) throw new RecordError(`FEN rank ${r + 1} has ${n} files, not 9`);
  });
  if (kings.r !== 1 || kings.b !== 1) throw new RecordError('FEN needs exactly one king per side');
  const e = new Engine(rows + ' ' + (turn === 'b' ? 'b' : 'w'));
  for (const s of ['r', 'b'] as Side[]) {
    const k = e.kingSquare(s), r = (k / 9) | 0, c = k % 9;
    if (c < 3 || c > 5 || (s === 'r' ? r < 7 : r > 2)) throw new RecordError('A king stands outside its palace');
  }
  if (e.inCheck(e.turn === 'r' ? 'b' : 'r')) throw new RecordError('The side not to move is in check');
  return fenOf(e.board, e.turn);
}

const sorted = (e: Engine) => e.legalMoves().map((m) => m.from * 90 + m.to).sort((a, b) => a - b);

/** Compact record of a game (see the header). */
export function encode(e: Engine): string {
  const fen = startFen(e), r = new Engine(fen);
  let s = RECORD_VERSION + (fen === START_FEN ? '' : '~' + fen.replace(' ', '_')) + '.';
  for (const m of e.history) {
    const all = sorted(r), i = all.indexOf(m.from * 90 + m.to);
    if (i < 0 || !r.move(m.from, m.to)) throw new RecordError(`Move ${sqName(m.from)}${sqName(m.to)} is not legal here`);
    s += all.length <= 64 ? B64[i] : B64[i >> 6] + B64[i & 63];
  }
  return s;
}

/** Play `moves` from `fen`, rejecting any illegal move or any move after the game has ended. */
function replay(fen: string, more: () => boolean, next: (e: Engine, n: number) => Ply): GameRecord {
  const e = new Engine(fen), out: Ply[] = [];
  for (let n = 1; more(); n++) {
    const st = e.status();
    if (st.over) throw new RecordError(`Move ${n} comes after the game ended (${st.reason})`);
    const m = next(e, n);
    if (!e.move(m.from, m.to)) throw new RecordError(`Move ${n} (${sqName(m.from)}${sqName(m.to)}) is illegal`);
    out.push(m);
  }
  return { fen, moves: out, engine: e };
}

/** Parse a record in either form, a link containing one (`...#g=<record>`), or bare ICCS moves. */
export function decode(text: string): GameRecord {
  let t = text.trim();
  const h = t.indexOf('#g=');
  if (h >= 0) t = t.slice(h + 3).split(/\s/)[0];
  try { t = decodeURIComponent(t); } catch { /* not URI-encoded */ }
  const compact = /^(\d+)([.~])/.exec(t);
  if (compact) {
    if (compact[1] !== RECORD_VERSION) throw new RecordError(`Unsupported record version ${compact[1]}`);
    let body = t.slice(compact[0].length), fen = START_FEN;
    if (compact[2] === '~') {
      const dot = body.indexOf('.');
      if (dot < 0) throw new RecordError('Record has a start position but no move list');
      fen = checkFen(body.slice(0, dot).replace(/_/g, ' ')); body = body.slice(dot + 1);
    }
    let p = 0;
    const digit = () => {
      const v = B64.indexOf(body[p++]);
      if (v < 0) throw new RecordError(`Bad character "${body[p - 1]}" at ply ${p}`);
      return v;
    };
    return replay(fen, () => p < body.length, (e, n) => {
      const all = sorted(e), i = all.length <= 64 ? digit() : digit() * 64 + digit();
      if (i >= all.length) throw new RecordError(`Move ${n} is illegal (index ${i} of ${all.length})`);
      return { from: (all[i] / 90) | 0, to: all[i] % 90 };
    });
  }
  // Readable form: an optional FEN line, then ICCS tokens; numbers and traditional notation are ignored.
  const fl = /^\s*FEN:?\s*(.+)$/im.exec(t);
  const fen = fl ? checkFen(fl[1]) : START_FEN;
  const body = fl ? t.replace(fl[0], '') : t;
  const tokens = body.match(/\b[a-i][0-9][-]?[a-i][0-9]\b/gi) ?? [];
  if (!tokens.length && /[^\s\d.:]/.test(body.replace(/[^\x00-\x7f]/g, ''))) throw new RecordError('No moves found in the record');
  let k = 0;
  return replay(fen, () => k < tokens.length, () => {
    const s = tokens[k++].toLowerCase().replace('-', '');
    return { from: sq(s.slice(0, 2)), to: sq(s.slice(2, 4)) };
  });
}

const RESULT: Record<string, string> = { checkmate: '绝杀', stalemate: '困毙', perpetual: '长将判负', repetition: '三次重复', nocapture: '久战无果' };
/** Chinese result line for a finished game, e.g. 红方胜 · 绝杀. */
export function resultText(st: Status): string {
  return (st.winner === 'r' ? '红方胜' : st.winner === 'b' ? '黑方胜' : '和棋') + ' · ' + RESULT[st.reason ?? 'nocapture'];
}

/** Human-readable record: pairs of ICCS moves with the traditional notation, which decode() also reads. */
export function toText(e: Engine): string {
  const fen = startFen(e), out = ['楚漢爭鋒 棋谱'];
  if (fen !== START_FEN) out.push('FEN: ' + fen);
  const h = e.history, first = h.length && h[0].piece.side === 'b' ? 1 : 0;
  // A game that starts with black to move opens with "1. ...".
  for (let i = -first, n = 1; i < h.length; i += 2, n++) {
    const a = h[i], b = h[i + 1];
    const iccs = (a ? sqName(a.from) + sqName(a.to) : '....') + (b ? ' ' + sqName(b.from) + sqName(b.to) : '');
    out.push(`${String(n).padStart(3)}. ${iccs.padEnd(9)}  ${a ? a.notation : '……'}${b ? ' ' + b.notation : ''}`);
  }
  const st = e.status();
  if (st.over) out.push('结果: ' + resultText(st));
  return out.join('\n');
}
