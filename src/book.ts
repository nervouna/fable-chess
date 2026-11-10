// Opening book: a few mainstream lines, a handful of plies deep, written in traditional notation.
// At load every line is replayed through the rules engine (each move resolved by its notation among
// the legal moves, so a wrong wing cannot slip in), mirrored left-right, and compiled into a map from
// position hash to weighted candidate moves. The AI plays from it while the game is still in it.
import { Engine, START_FEN, sq, sqName } from './engine.ts';
import { encode, hashBoard, legalPairs, type Style } from './ai.ts';

export interface Line {
  /** Full name of the line. */
  name: string;
  /** What red's play is called, announced on red's first book move ('中炮'). */
  red: string;
  /** What black's answer is called, announced once it is unambiguous; none when it has no settled name. */
  black?: string;
  /** 0 quiet .. 2 sharp: aggressive leans to sharp lines, solid to quiet ones. */
  sharp: number;
  moves: string;
}

export const LINES: Line[] = [
  { name: '中炮过河车对屏风马', red: '中炮', black: '中炮对屏风马', sharp: 2, moves: '炮二平五 马8进7 马二进三 车9平8 车一平二 马2进3 兵七进一 卒7进1 车二进六 炮8平9' },
  { name: '五七炮对屏风马', red: '中炮', black: '中炮对屏风马', sharp: 1, moves: '炮二平五 马8进7 马二进三 卒7进1 车一平二 车9平8 马八进九 马2进3 炮八平七 车1平2 车九平八' },
  { name: '顺炮直车对横车', red: '中炮', black: '顺炮', sharp: 2, moves: '炮二平五 炮8平5 马二进三 马8进7 车一平二 车9进1 马八进七 车9平4' },
  { name: '中炮直车对列炮', red: '中炮', black: '列炮', sharp: 2, moves: '炮二平五 炮2平5 马二进三 马2进3 车一平二 车1平2 马八进七 马8进7' },
  { name: '中炮对反宫马', red: '中炮', black: '中炮对反宫马', sharp: 1, moves: '炮二平五 马2进3 马二进三 炮8平6 车一平二 马8进7' },
  { name: '飞相对进7卒', red: '飞相局', black: '飞相对进7卒', sharp: 0, moves: '相三进五 卒7进1 兵七进一 马8进7 马八进七 马2进3' },
  { name: '仙人指路对卒底炮', red: '仙人指路', black: '仙人指路对卒底炮', sharp: 2, moves: '兵七进一 炮2平3 炮二平五 象3进5 马二进三 马8进7' },
  { name: '对兵局', red: '仙人指路', black: '对兵局', sharp: 0, moves: '兵七进一 卒7进1 马八进七 马8进7 马二进三' },
  { name: '起马对挺卒', red: '起马局', black: '起马对挺卒', sharp: 0, moves: '马八进七 卒7进1 兵七进一 马8进7 马二进三' },
  { name: '过宫炮', red: '过宫炮', sharp: 1, moves: '炮二平六 马8进7 马二进三 车9平8 车一平二 卒7进1' },
];

/** A compiled line: the book line or its mirror image, as ICCS moves. */
interface Path { line: Line; iccs: string[]; weight: number }
export interface BookMove { move: string; from: number; to: number; weight: number; names: string[] }
interface Cand { move: string; from: number; to: number; piece: number; paths: Path[] }

const mirror = (m: string) => m.replace(/[a-i]/g, (c) => String.fromCharCode(202 - c.charCodeAt(0))); // a <-> i

/** Resolve a line's notation to ICCS moves; throws on a move that is not legal where it stands. */
export function resolve(line: Line): string[] {
  const e = new Engine(START_FEN), out: string[] = [];
  for (const n of line.moves.split(' ')) {
    const m = e.legalMoves().find((x) => e.notate(x.from, x.to) === n);
    if (!m) throw new Error(`book: ${line.name}: ${n} is not legal after ${out.join(' ')}`);
    out.push(sqName(m.from) + sqName(m.to)); e.move(m.from, m.to);
  }
  return out;
}

export const PATHS: Path[] = LINES.flatMap((line) => {
  const iccs = resolve(line);
  return [{ line, iccs, weight: 3 }, { line, iccs: iccs.map(mirror), weight: 1 }]; // the usual wing is the usual choice
});

const BOOK = new Map<number, Map<string, Cand>>();
for (const p of PATHS) {
  const e = new Engine(START_FEN);
  for (const m of p.iccs) {
    const from = sq(m.slice(0, 2)), to = sq(m.slice(2)), board = encode(e.board), h = hashBoard(board, e.turn === 'r' ? 0 : 1);
    let at = BOOK.get(h);
    if (!at) BOOK.set(h, (at = new Map()));
    let c = at.get(m);
    if (!c) at.set(m, (c = { move: m, from, to, piece: board[from], paths: [] }));
    c.paths.push(p);
    if (!e.move(from, to)) throw new Error(`book: mirrored ${p.line.name}: ${m} is illegal`);
  }
}

const styleWeight = (p: Path, style: Style) => p.weight * (style === 'aggressive' ? 1 + p.line.sharp * 2 : style === 'solid' ? 5 - p.line.sharp * 2 : 1);

/** Book moves for a position (already checked legal there), weighted for `style`. */
export function bookMoves(board: number[], turn: 0 | 1, style: Style = 'balanced'): BookMove[] {
  const at = BOOK.get(hashBoard(board, turn));
  if (!at) return [];
  const legal = new Set(legalPairs(board, turn).map(([f, t]) => f * 90 + t));
  const out: BookMove[] = [];
  for (const c of at.values()) {
    if (board[c.from] !== c.piece || !legal.has(c.from * 90 + c.to)) continue; // a hash collision, not a book position
    out.push({ move: c.move, from: c.from, to: c.to, weight: c.paths.reduce((s, p) => s + styleWeight(p, style), 0), names: [...new Set(c.paths.map((p) => p.line.name))] });
  }
  return out;
}

/** A weighted random book move, or null when the position is out of book. */
export function bookPick(board: number[], turn: 0 | 1, style: Style = 'balanced', rnd = Math.random): BookMove | null {
  const ms = bookMoves(board, turn, style);
  let r = rnd() * ms.reduce((s, m) => s + m.weight, 0);
  for (const m of ms) if ((r -= m.weight) < 0) return m;
  return ms.at(-1) ?? null;
}

/**
 * The name the side that just moved is playing, given the whole game so far in ICCS: red's opening,
 * or black's answer, once every book line the game still follows agrees on it. Null otherwise.
 */
export function openingName(moves: string[], side: 'r' | 'b'): string | null {
  const names = new Set<string | undefined>();
  for (const p of PATHS) if (moves.length <= p.iccs.length && moves.every((m, i) => p.iccs[i] === m)) names.add(side === 'r' ? p.line.red : p.line.black);
  return names.size === 1 ? [...names][0] ?? null : null;
}
