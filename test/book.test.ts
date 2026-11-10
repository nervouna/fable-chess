// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN, sq, sqName } from '../src/engine.ts';
import { encode, hashKey, search, STYLES } from '../src/ai.ts';
import { LINES, PATHS, bookMoves, bookPick, openingName, resolve } from '../src/book.ts';
import { exposed, judge, line, mateIn, sacrificed, type Verdict } from '../src/commentary.ts';

const turnOf = (e: Engine) => (e.turn === 'r' ? 0 : 1) as 0 | 1;
const playAll = (e: Engine, moves: string[]) => { for (const m of moves) assert.ok(e.move(sq(m.slice(0, 2)), sq(m.slice(2))), m); return e; };

// Every line is legal, and the Engine writes each move exactly as the line does (no wrong-wing slips).
for (const line of LINES) {
  const iccs = resolve(line), e = playAll(new Engine(), iccs);
  assert.deepEqual(e.history.map((m) => m.notation), line.moves.split(' '), line.name);
  assert.ok(iccs.length >= 5 && iccs.length <= 12, `${line.name}: ${iccs.length} plies`);
}
assert.equal(resolve(LINES[0])[0], 'h2e2'); // 炮二平五

// Mirrored lines: legal, and their notation is the original's with every file number reflected.
const FILES = '一二三四五六七八九', reflect = (n: string, straight: boolean) => n.replace(/^(\D)(.)(.)(.)$/, (_, p, f, a, t) => {
  const r = (c: string) => (FILES.includes(c) ? FILES[8 - FILES.indexOf(c)] : String(10 - +c));
  return p + r(f) + a + (a === '平' || !straight ? r(t) : t);
});
for (let i = 0; i < PATHS.length; i += 2) {
  const [a, b] = [PATHS[i], PATHS[i + 1]];
  assert.equal(a.line, b.line);
  const ea = playAll(new Engine(), a.iccs), eb = playAll(new Engine(), b.iccs);
  ea.history.forEach((m, k) => assert.equal(eb.history[k].notation, reflect(m.notation, 'RCPK'.includes(m.piece.type)), `${a.line.name} mirror ply ${k}`));
}

// The hash lookup finds every position along every line, offering the line's next move.
for (const p of PATHS) {
  const e = new Engine();
  for (const m of p.iccs) {
    const ms = bookMoves(encode(e.board), turnOf(e));
    assert.ok(ms.some((c) => c.move === m && c.names.includes(p.line.name)), `${p.line.name}: ${m} at ply ${e.history.length}`);
    playAll(e, [m]);
  }
}
// Out of book: nothing offered, and a book pick is always legal and from the candidates.
assert.deepEqual(bookMoves(encode(new Engine('3k5/9/9/9/9/9/9/9/9/R3K4 w').board), 0), []);
{
  const e = new Engine(), seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const b = bookPick(encode(e.board), 0, STYLES[i % 3])!;
    assert.ok(e.legalFrom(b.from).includes(b.to)); seen.add(b.move);
  }
  assert.ok(seen.size >= 5, 'several first moves');
  // Aggressive leans to sharp lines: 中炮 gets a larger share of the first move than for solid.
  const share = (s: 'aggressive' | 'solid') => { const ms = bookMoves(encode(e.board), 0, s), w = (f: (m: string) => boolean) => ms.filter((m) => f(m.move)).reduce((n, m) => n + m.weight, 0); return w((m) => m === 'h2e2' || m === 'b2e2') / w(() => true); };
  assert.ok(share('aggressive') > share('solid'), 'aggressive opens 中炮 more often');
}

// Names: red's opening on its first move, black's answer once the lines agree.
assert.equal(openingName(['h2e2'], 'r'), '中炮');
assert.equal(openingName(['b2e2'], 'r'), '中炮');
assert.equal(openingName(['h2e2', 'h9g7'], 'b'), '中炮对屏风马');
assert.equal(openingName(['b2e2', 'b9c7'], 'b'), '中炮对屏风马');
assert.equal(openingName(['h2e2', 'h7e7'], 'b'), '顺炮');
assert.equal(openingName(['h2e2', 'b7e7'], 'b'), '列炮');
assert.equal(openingName(['h2e2', 'b9c7'], 'b'), '中炮对反宫马');
assert.equal(openingName(['c3c4', 'b7c7'], 'b'), '仙人指路对卒底炮');
assert.equal(openingName(['h2d2', 'h9g7'], 'b'), null); // no settled name for black there
assert.equal(openingName(['h2e2', 'a6a5'], 'b'), null); // out of book

// No book move gives anything away: after it, the engine's own depth-4 search scores the position
// within 40 (about a pawn) of the best move it finds there itself.
{
  let worst = 0;
  for (const p of PATHS) {
    const e = new Engine();
    for (const m of p.iccs) {
      const t = turnOf(e), best = search({ board: encode(e.board), turn: t, depth: 4 })!.score;
      playAll(e, [m]);
      const after = -search({ board: encode(e.board), turn: (1 - t) as 0 | 1, depth: 3 })!.score;
      assert.ok(after >= best - 40, `${p.line.name}: ${m} loses ${best - after}`);
      worst = Math.min(worst, after - best);
    }
  }
  console.log(`book: ${LINES.length} lines, ${PATHS.length} with mirrors, worst book move ${worst} against the engine's best`);
}

// Balanced is the evaluation from before styles existed: scores, moves and node counts captured from
// the search on origin/main (commit 0079507), one with game history so repetition is in play.
for (const [fen, moves, depth, mv, score, nodes] of [
  [START_FEN, '', 4, 'b0c2', 0, 20581],
  [START_FEN, 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5', 4, 'h0h6', 1, 25451],
  ['r1bakab1r/9/1cn4c1/p1p1p1p1p/9/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB1R b', '', 4, 'h7g7', -283, 15060],
  ['2bakab2/9/2n1c1n2/p1p1p3p/6p2/2P6/P3P1P1P/2N1C1N2/4A4/2BAK1B2 w', '', 4, 'c2d4', 33, 5658],
  ['3ak4/4a4/4b4/p3p4/2b6/2P3R2/P8/4B4/4A4/2BAK4 w', '', 4, 'c4c5', 736, 3210],
  ['3k5/9/9/9/9/9/9/9/9/R3K4 w', 'a0a1 d9d8 a1a0 d8d9', 4, 'a0d0', 29999, 35],
] as [string, string, number, string, number, number][]) {
  const e = playAll(new Engine(fen), moves.split(' ').filter(Boolean)), reps = e.keys.slice(0, -1).map(hashKey);
  for (const style of [undefined, 'balanced'] as const) {
    const r = search({ board: encode(e.board), turn: turnOf(e), depth, reps, style })!;
    assert.deepEqual([sqName(r.from) + sqName(r.to), r.score, r.nodes], [mv, score, nodes], `balanced pin ${fen} ${moves}`);
  }
}

// Aggressive and solid choose differently in these positions (found by scanning games): aggressive
// pushes a pawn or jumps a horse forward, solid flies an elephant or brings a rook home.
{
  let differ = 0;
  for (const fen of [
    'r1bakab1r/9/1cn4c1/p1N1p3p/6p2/2P6/P3P1n1P/1C4NC1/9/R1BAKAB1R w',
    'rnbakab1r/9/1c5c1/p1p1p3p/5np2/2P6/P3P1P1P/1CN3NC1/9/R1BAKAB1R w',
    'r1bakab1r/9/1cn4c1/p1N1p3p/5np2/2P6/P3P1P1P/1C4NC1/9/R1BAKAB1R b',
    '2baka1r1/r8/n3b1nc1/p1p1p3R/1c4p1p/9/P1P1P1P1P/1CNCB1N2/4A4/R3KAB2 b',
  ]) {
    const e = new Engine(fen), pick = (style: 'aggressive' | 'solid') => { const r = search({ board: encode(e.board), turn: turnOf(e), depth: 4, style })!; return sqName(r.from) + sqName(r.to); };
    const a = pick('aggressive'), s = pick('solid');
    if (a !== s) differ++;
    for (const m of [a, s]) assert.ok(e.legalFrom(sq(m.slice(0, 2))).includes(sq(m.slice(2))));
  }
  assert.equal(differ, 4, 'styles differ in every scanned position');
  // A level position scores near zero in every style (the style terms are normalised).
  for (const style of STYLES) assert.ok(Math.abs(search({ board: encode(new Engine().board), turn: 0, depth: 3, style })!.score) < 40, style);
}

// Commentary: a rook left to a horse is exposed; a defended one is not; moments are judged sparingly.
{
  assert.equal(exposed(new Engine('3k5/9/9/9/2n6/9/3R5/9/9/4K4 b'), sq('d3')), 600);
  assert.equal(exposed(new Engine('3k5/9/9/9/2n6/9/3R5/9/3R5/4K4 b'), sq('d3')), 600 - 270); // recaptured
  const e = playAll(new Engine('3k5/9/9/9/2n6/9/9/9/9/R3K4 w'), ['a0a3', 'd9d8', 'a3d3']);
  assert.equal(sacrificed(e), 600);
  const none = new Set<never>(), v = (score: number, prev: number | null, o: Partial<Verdict> = {}): Verdict => ({ score, prev, given: 0, taken: 0, since: 20, ...o });
  assert.equal(judge(v(29995, 0), none), 'mate'); assert.equal(judge(v(29995, 0), new Set(['mate'])), null);
  assert.equal(judge(v(29995, 0, { since: 1 }), none), 'mate'); // a found mate is never held back
  assert.equal(judge(v(-29990, 0), none), 'doomed'); assert.equal(judge(v(-29990, 0, { since: 3 }), none), null);
  assert.equal(judge(v(300, 0, { given: 600 }), none), 'sacrifice'); assert.equal(judge(v(-50, 0, { given: 600 }), none), null);
  assert.equal(judge(v(400, 50), none), 'surge'); assert.equal(judge(v(-400, -50), none), 'slump'); assert.equal(judge(v(120, 60), none), null);
  assert.equal(judge(v(270, 230), none), 'edge'); assert.equal(judge(v(270, 230), new Set(['edge'])), null);
  assert.equal(judge(v(-270, -230), none), 'strain');
  assert.equal(judge(v(10, 0, { taken: 600 }), none), 'trade'); assert.equal(judge(v(10, 0, { taken: 600, since: 8 }), none), null);
  assert.equal(judge(v(400, 50, { since: 5 }), none), null); // too soon after the last remark
  assert.equal(mateIn(29995), 3);
  assert.ok(line('mate', 'aggressive', 29995).includes('三'));
  const a = line('slump', 'solid', 0), b = line('slump', 'solid', 0);
  assert.notEqual(a, b, 'no line twice in a row');
}

console.log('book tests passed');
