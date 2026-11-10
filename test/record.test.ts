// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN, sq, sqName } from '../src/engine.ts';
import { RecordError, checkFen, decode, encode, startFen, toText } from '../src/record.ts';

const play = (e: Engine, moves: string) => { for (const m of moves.split(' ')) assert.ok(e.move(sq(m.slice(0, 2)), sq(m.slice(2))), m); return e; };
const same = (a: Engine, b: Engine) => {
  assert.equal(b.key(), a.key());
  assert.deepEqual(b.history.map((m) => m.notation), a.history.map((m) => m.notation));
};
/** A long pseudo-random game (seeded, so the test is stable) that stops before the game ends. */
function randomGame(plies: number, seed: number, fen = START_FEN) {
  const e = new Engine(fen);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  while (e.history.length < plies && !e.status().over) {
    const all = e.legalMoves(), caps = all.filter((m) => e.board[m.to]);
    const pick = caps.length && rnd() < 0.5 ? caps : all;
    const m = pick[(rnd() * pick.length) | 0];
    e.move(m.from, m.to);
  }
  return e;
}

// Round trip of an opening with captures; the standard start is omitted.
{
  const e = play(new Engine(), 'h2e2 h9g7 e2e6 a9a8 h0g2 b7b0 a0a1');
  const code = encode(e);
  assert.ok(code.startsWith('1.') && !code.includes('~'));
  assert.equal(code.length, 2 + 7);
  same(e, decode(code).engine);
  same(e, decode(toText(e)).engine); // the readable form decodes too
  same(e, decode('https://example.org/fable-chess/?q=low#g=' + code).engine); // and a whole link
  same(e, decode('h2e2 h9g7 e2e6 a9a8 h0g2 b7b0 a0a1').engine); // and bare ICCS
  assert.deepEqual(decode(code).moves.map((m) => sqName(m.from) + sqName(m.to)).join(' '), 'h2e2 h9g7 e2e6 a9a8 h0g2 b7b0 a0a1');
}

// Empty game, and the readable form with move numbers but no header.
{
  assert.equal(encode(new Engine()), '1.');
  assert.equal(decode('1.').moves.length, 0);
  assert.equal(decode(toText(new Engine())).moves.length, 0);
  assert.equal(decode('1. h2e2 h9g7\n2. h0g2').moves.length, 3);
}

// Positions with more than 64 legal moves take two characters per ply.
{
  const fen = '4k4/9/P1P1P1P1P/9/1R5R1/9/2C1N1C2/9/4N4/3AKA3 w', e = new Engine(fen);
  assert.ok(e.legalMoves().length > 64);
  let s = 9;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let i = 0; i < 12 && !e.status().over; i++) { const all = e.legalMoves(); const m = all[(rnd() * all.length) | 0]; e.move(m.from, m.to); }
  const code = encode(e);
  assert.ok(code.length > code.indexOf('.') + 1 + e.history.length, 'some plies used two characters');
  same(e, decode(code).engine);
}

// Long games stay short enough for a URL and survive the round trip.
for (const seed of [1, 7, 42, 2024]) {
  const e = randomGame(100, seed);
  const code = encode(e);
  assert.ok(code.length < 130, `100-ply record is ${code.length} chars`);
  assert.match(code, /^[0-9A-Za-z._~\-]+$/); // URL-safe without escaping
  same(e, decode(code).engine);
  same(e, decode(toText(e)).engine);
}

// Non-standard start (black to move) round trips, and the start position is carried.
{
  const fen = '3k5/9/9/9/9/9/9/R8/1R7/4K4 b';
  const e = randomGame(30, 5, fen);
  const code = encode(e);
  assert.ok(code.startsWith('1~3k5/9/9/9/9/9/9/R8/1R7/4K4_b.'));
  const d = decode(code);
  assert.equal(d.fen, fen); assert.equal(startFen(d.engine), fen);
  same(e, d.engine);
  same(e, decode(toText(e)).engine);
}

// A finished game decodes; the text names the result. Nothing may follow the final move.
{
  const e = play(new Engine('3k5/9/9/9/R8/4R4/9/9/9/5K3 w'), 'e4e3 d9d8 e3e4 d8d9');
  assert.equal(e.status().reason, null);
  play(e, 'a5d5');
  assert.equal(e.status().reason, 'checkmate');
  const code = encode(e), d = decode(code);
  assert.equal(d.engine.status().reason, 'checkmate');
  assert.match(toText(e), /结果: 红方胜 · 绝杀/);
  assert.throws(() => decode(code + 'A'), /after the game ended/);
}

// Illegal and malformed input is rejected with a clear error.
{
  const bad = (text: string, re: RegExp) => assert.throws(() => decode(text), (err: unknown) => err instanceof RecordError && re.test(err.message), text);
  bad('h2e2 h2e3', /Move 2 \(h2e3\) is illegal/); // red cannon is gone from h2; it is black's turn anyway
  bad('a0a5', /Move 1 \(a0a5\) is illegal/); // rook blocked by its own pawn
  bad('1.!', /Bad character/);
  bad('1._', /Move 1 is illegal/); // index 63 of 44 legal moves
  bad('9.AAA', /Unsupported record version 9/);
  bad('1~rnbakabnr/9/9.A', /10 ranks/);
  bad('1~3k5/9/9/9/9/9/9/R8/1R7/4K4_x.', /side to move/);
  bad('1~3k5/9/9/9/9/9/9/R8/1R7/9_w.', /one king per side/);
  bad('1~3k5/9/9/9/9/9/9/R7/1R7/4K4_w.', /rank 8 has 8 files/);
  bad('1~3k5/9/9/9/9/9/9/R8/1R7/4K4_w', /no move list/);
  bad('hello world', /No moves found/);
  bad('你好', /No moves found/);
  bad('123', /No moves found/);
  bad('https://example.org/#g=', /No moves found/);
  bad('#g=5', /No moves found/);
  assert.equal(checkFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r'), START_FEN);
}

console.log('record tests passed');
