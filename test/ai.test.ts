// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN, sq, sqName } from '../src/engine.ts';
import { encode, hashBoard, perft, search } from '../src/ai.ts';

const turnOf = (e: Engine) => (e.turn === 'r' ? 0 : 1);

// The search's own move generator must agree with the rules engine.
for (const [fen, depth] of [
  [START_FEN, 3],
  ['r1bakab1r/9/1cn4c1/p1p1p1p1p/9/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB1R b', 3],
  ['5k3/4a4/4b4/9/2n1P4/9/9/4C4/4A4/3RK4 w', 3], // cannon, hobbled horse, pinned advisor
  ['4k4/9/9/9/9/9/9/4r4/9/4K4 w', 3], // flying general and check evasion
  ['3ak4/4a4/9/9/9/9/9/9/4p4/3K1R3 w', 4],
] as [string, number][]) {
  const e = new Engine(fen);
  assert.equal(perft(encode(e.board), turnOf(e), depth), e.perft(depth), `perft ${fen}`);
}

const best = (fen: string, depth: number) => { const e = new Engine(fen), r = search({ board: encode(e.board), turn: turnOf(e), depth })!; return { mv: sqName(r.from) + sqName(r.to), ...r }; };

// Takes a free rook.
assert.equal(best('3k5/9/9/9/9/9/9/9/4R3r/5K3 w', 3).mv, 'e1i1');
// Mate in one: the second rook closes the back rank.
{
  const r = best('4k4/R8/1R7/9/9/9/9/9/9/3K5 w', 3);
  assert.equal(r.mv, 'b7b9'); assert.ok(r.score > 29000);
}
// Mate in two is found and reported as a mate score.
{
  const fen = '3k5/9/9/9/9/9/9/R8/1R7/4K4 w', r = best(fen, 5);
  assert.ok(r.score > 29000, 'mate score');
  // Play it out against every reply: the follow-up must mate.
  const e = new Engine(fen); assert.ok(e.move(r.from, r.to));
  for (const reply of e.legalMoves()) {
    assert.ok(e.move(reply.from, reply.to));
    const f = search({ board: encode(e.board), turn: turnOf(e), depth: 3 })!;
    assert.ok(e.move(f.from, f.to)); assert.equal(e.status().reason, 'checkmate');
    e.undo(); e.undo();
  }
}

// Draw rules in the engine.
{
  const e = new Engine('3k5/9/9/9/9/9/9/9/9/R3K4 w');
  const shuffle = ['a0a1', 'd9d8', 'a1a0', 'd8d9'];
  for (let i = 0; i < 8; i++) { const m = shuffle[i % 4]; assert.ok(e.move(sq(m.slice(0, 2)), sq(m.slice(2)))); }
  const st = e.status();
  assert.deepEqual([st.over, st.winner, st.reason], [true, null, 'repetition']);
  e.undo();
  assert.equal(e.status().over, false);
}
{
  // Red checks forever with the rook: red loses.
  const e = new Engine('3k5/9/9/9/9/9/9/9/9/R3K4 w');
  assert.ok(e.move(sq('a0'), sq('a9')));
  const loop = ['d9d8', 'a9a8', 'd8d9', 'a8a9'];
  let st = e.status();
  for (let i = 0; i < 16 && !st.over; i++) { const m = loop[i % 4]; assert.ok(e.move(sq(m.slice(0, 2)), sq(m.slice(2))), m); st = e.status(); }
  assert.deepEqual([st.over, st.winner, st.reason], [true, 'b', 'perpetual']);
}

// Self-play soak: every move the search returns is legal and games reach a result. A legal game can
// outlast any ply cap (each capture restarts the 120-ply no-capture count), so a rare game that hits
// the cap is counted as unfinished instead of failing the run.
{
  const results: Record<string, number> = {}, lines = new Set<string>();
  let plies = 0;
  const t0 = Date.now(), GAMES = 20;
  for (let g = 0; g < GAMES; g++) {
    const e = new Engine(), reps: number[] = [];
    let st = e.status();
    while (!st.over && e.history.length < 400) {
      const board = encode(e.board);
      const r = search({ board, turn: turnOf(e), reps, depth: 3, variety: e.history.length < 6 });
      assert.ok(r, 'search returned a move');
      reps.push(hashBoard(board, turnOf(e)));
      assert.ok(e.move(r.from, r.to), `illegal move ${sqName(r.from)}${sqName(r.to)} in game ${g}`);
      st = e.status();
    }
    const how = st.over ? st.reason! : 'unfinished';
    results[how] = (results[how] ?? 0) + 1;
    plies += e.history.length;
    lines.add(e.history.slice(0, 8).map((m) => m.notation).join(' '));
  }
  console.log(`self-play: ${GAMES} games, avg ${Math.round(plies / GAMES)} plies, ${JSON.stringify(results)}, ${lines.size} distinct openings, ${Date.now() - t0} ms`);
  assert.ok(lines.size > 1, 'games differ');
  assert.ok((results.unfinished ?? 0) <= 2, 'almost every game ends within the ply cap');
}

console.log('ai tests passed');
