// Traditional Chinese move notation (炮二平五, 马8进7, 前车进一 …) read back into moves: the inverse of
// Engine.notate. A move is matched against the spellings of every legal move in the position, so the
// rules live in one place (the generator) and anything it writes reads back as the same move.
//
// Accepted spellings, all case of the same four parts (piece/tag, file, 进/退/平, number):
// - simplified or traditional glyphs and either side's names: 車俥车, 馬傌马, 砲包炮, 帥將帅将, 仕士, 相象,
//   兵卒, 進进, 後后; 上/下 for 进/退;
// - file and step numbers as Chinese numerals, ASCII or full-width digits, for either side;
// - pieces sharing a file: 前/后 (two), 前/中/后 or 一二三 (three pawns), 一二三四五 or 前…后 (more);
//   when two files hold several pawns, the generator's 一兵…五兵 numbering, or the older 前兵四 / 前四;
// - the plain form (车六进一) of a piece that shares its file, when only one such move fits.
import { type Engine, stacks } from './engine.ts';

export class NotationError extends Error {}

/** One character for each input character (so positions line up with the original text). */
const MAP: Record<string, string> = {};
const put = (chars: string, to: string) => { for (const ch of chars) MAP[ch] = to; };
put('帅帥将將', 'K'); put('仕士', 'A'); put('相象', 'B'); put('马馬傌㐷', 'N'); put('车車俥伡', 'R'); put('炮砲包', 'C'); put('兵卒', 'P');
put('进進上', '+'); put('退下', '-'); put('平', '=');
put('后後', '后');
'一二三四五六七八九'.split('').forEach((c, i) => put(c, String(i + 1)));
'１２３４５６７８９'.split('').forEach((c, i) => put(c, String(i + 1)));
const norm = (s: string) => Array.from(s, (ch) => MAP[ch] ?? ch).join('');

const PIECE = 'KABNRCP';

/** Every accepted spelling of a legal move, normalised. The first is the generator's own. */
function spellings(e: Engine, from: number, to: number): string[] {
  const canon = norm(e.notate(from, to)), p = e.board[from]!;
  if (p.type === 'K' || p.type === 'A' || p.type === 'B') return [canon];
  const fr = (from / 9) | 0, fc = from % 9;
  const file = String(p.side === 'r' ? 9 - fc : fc + 1), letter = p.type, tail = canon.slice(-2);
  const files = stacks(e.board, p.side, p.type), own = files.get(fc)!, n = own.length, k = own.indexOf(fr);
  if (n < 2) return [canon];
  const tags = [String(k + 1)]; // 一二三… from the front
  if (n === 2) tags.push(k ? '后' : '前');
  else {
    if (k === 0) tags.push('前');
    if (k === n - 1) tags.push('后');
    if (n === 3 && k === 1) tags.push('中');
  }
  const multi = [...files.values()].filter((s) => s.length > 1).length > 1;
  const heads = [letter + file];
  // 一兵, 二兵 … counted on this file (a numeral after the piece would read as a file; with two crowded
  // files the generator's own numbering, across both, is the only one).
  if (!multi) heads.push(tags[0] + letter);
  for (const t of tags.slice(1)) heads.push(t + letter, letter + t, ...(multi ? [t + letter + file, t + file] : []));
  return [canon, ...heads.map((h) => h + tail)];
}

/** The legal move `text` names in the current position (side to move). Throws NotationError. */
export function parseMove(e: Engine, text: string): { from: number; to: number } {
  const want = norm(text.replace(/\s+/g, ''));
  if (!/^[^+\-=]{2,3}[+\-=][1-9]$/.test(want)) throw new NotationError(`"${text}" is not a move in Chinese notation`);
  const hits = e.legalMoves().filter((m) => spellings(e, m.from, m.to).includes(want));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new NotationError(`"${text}" is not a legal move for ${e.turn === 'r' ? 'red' : 'black'} here`);
  throw new NotationError(`"${text}" is ambiguous: ${hits.map((m) => e.notate(m.from, m.to)).join(', ')}`);
}

// A move token: a head (piece and file, or a 前/中/后/一二三 tag with the piece and/or file) and a tail.
const TOKEN = new RegExp(`(?:[前中后1-5][${PIECE}][1-9]?|[前中后1-5][1-9]|[${PIECE}][1-9前中后])[+\\-=][1-9]`, 'g');

/** The moves written in a block of text, in order, as they appear there. Commentary in brackets is skipped. */
export function notationTokens(text: string): string[] {
  const bare = text.replace(/\{[^}]*\}|\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, (s) => ' '.repeat(s.length));
  const n = norm(bare), out: string[] = [];
  for (const m of n.matchAll(TOKEN)) out.push(bare.slice(m.index, m.index + m[0].length));
  return out;
}

/** Display form in traditional glyphs and full-width digits (马8进7 → 馬８進７, 前车进一 → 前車進一). */
export function traditional(s: string): string {
  const T: Record<string, string> = { 车: '車', 马: '馬', 进: '進', 帅: '帥', 将: '將', 后: '後' };
  return Array.from(s, (ch) => T[ch] ?? (/[1-9]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join('');
}
