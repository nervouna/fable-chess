// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN, sq } from '../src/engine.ts';
import { CLIP_SECONDS, REEL_MAX_CLIPS, REEL_SECONDS, highlights, plySeconds, type Clip } from '../src/reel.ts';
import type { Ply } from '../src/record.ts';

const parse = (s: string): Ply[] => s.split(' ').map((m) => ({ from: sq(m.slice(0, 2)), to: sq(m.slice(2)) }));
const plies = (e: Engine): Ply[] => e.history.map((m) => ({ from: m.from, to: m.to }));
/** Seeded random game that prefers captures; `untilMate` keeps trying seeds until one ends in checkmate. */
function randomGame(seed: number, maxPlies = 300) {
  const e = new Engine();
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  while (e.history.length < maxPlies && !e.status().over) {
    const all = e.legalMoves(), caps = all.filter((m) => e.board[m.to]);
    // Take a check that mates if there is one, so games end in checkmate reasonably often.
    const mates = all.filter((m) => { e.move(m.from, m.to); const over = e.status().reason === 'checkmate'; e.undo(); return over; });
    const pick = mates.length ? mates : caps.length && rnd() < 0.7 ? caps : all;
    const m = pick[(rnd() * pick.length) | 0];
    e.move(m.from, m.to);
  }
  return e;
}
const ordered = (clips: Clip[]) => {
  for (const c of clips) assert.ok(c.start < c.ply && c.ply <= c.end, `clip ${c.start}..${c.end} keeps its key ply ${c.ply}`);
  for (let i = 1; i < clips.length; i++) assert.ok(clips[i - 1].end <= clips[i].start, 'clips are in game order and do not overlap');
};

// No moves, no clips.
assert.deepEqual(highlights(START_FEN, []), []);

// A quiet game still yields one clip: its last move.
{
  const clips = highlights(START_FEN, parse('h2e2 h9g7 h0g2 i9h9'));
  assert.equal(clips.length, 1);
  assert.equal(clips[0].ply, 4); assert.equal(clips[0].end, 4);
  assert.equal(clips[0].start, 1, 'two quiet lead-in plies');
  assert.equal(clips[0].reason, '收官');
}

// Captures outrank quiet moves, and a chariot outranks a pawn.
{
  // 3. the red cannon takes the centre pawn (with check), 4. black's horse takes ... nothing; 5. quiet.
  const moves = parse('h2e2 h9g7 e2e6 a9a8 h0g2');
  const [best] = highlights(START_FEN, moves, { max: 1 });
  assert.equal(best.ply, 3, 'the capture is the highlight');
  assert.ok(best.score > 0);
  // Four captures in a row: rook takes horse, rook takes rook, ... The biggest one comes first by score.
  const caps = parse('h2h9 i9h9 b2b9 a9b9');
  const one = highlights(START_FEN, caps, { max: 1 })[0];
  const all = highlights(START_FEN, caps);
  ordered(all);
  assert.ok(all.every((c) => c.score > 0));
  assert.ok(all.some((c) => c.ply === one.ply));
  // h2h9 takes a horse and is answered by i9h9 taking the cannon back on h9: an exchange of both plies.
  assert.equal(all[0].start, 0); assert.equal(all[0].end, 2);
}

// A mate is always included and always last, even over the budget and the clip cap.
{
  let e: Engine | null = null;
  for (let seed = 1; seed < 200 && !e; seed++) {
    const g = randomGame(seed);
    if (g.status().reason === 'checkmate' && g.history.filter((m) => m.captured).length >= 8) e = g;
  }
  assert.ok(e, 'found a seeded game with 8+ captures that ends in checkmate');
  const moves = plies(e), n = moves.length;
  const clips = highlights(START_FEN, moves);
  ordered(clips);
  assert.equal(clips.at(-1)!.ply, n); assert.equal(clips.at(-1)!.end, n);
  assert.equal(clips.at(-1)!.reason, '绝杀');
  assert.ok(clips.length >= 2 && clips.length <= REEL_MAX_CLIPS, `clip count ${clips.length} is capped`);
  // Estimated running time stays inside the budget (lead-ins are budgeted at two plies each).
  const mv = e.history;
  const est = clips.reduce((t, c) => { t += CLIP_SECONDS; for (let k = c.start + 1; k <= c.end; k++) t += plySeconds(mv[k - 1], k === n); return t; }, 0);
  assert.ok(est <= REEL_SECONDS, `estimated ${est.toFixed(1)} s`);
  // Tiny budget and a cap of one: still the mate.
  const tiny = highlights(START_FEN, moves, { max: 1, seconds: 1 });
  assert.equal(tiny.length, 1); assert.equal(tiny[0].ply, n);
  // Captures are what the rest of the reel is made of.
  assert.ok(clips.slice(0, -1).every((c) => c.score >= 10));
}

// Long games: the cap holds, and the clips stay in order, for many seeds.
{
  let checked = 0;
  for (let seed = 300; seed < 330; seed++) {
    const e = randomGame(seed, 160), moves = plies(e);
    const clips = highlights(START_FEN, moves);
    ordered(clips);
    assert.ok(clips.length >= 1 && clips.length <= REEL_MAX_CLIPS);
    assert.ok(highlights(START_FEN, moves, { max: 3 }).length <= 3);
    const st = e.status();
    if (st.reason === 'checkmate') assert.equal(clips.at(-1)!.ply, moves.length);
    checked++;
  }
  assert.equal(checked, 30);
}

// King hunt: three checks in a row by red become one clip.
{
  // Red rook and horse chase the black king around its palace (a composed position).
  const fen = '3k5/9/9/9/9/9/9/9/4A4/R2AK4 w';
  const e = new Engine(fen);
  for (const m of ['a0a9', 'd9d8', 'a9a8', 'd8d9', 'a8a9', 'd9d8'].map((s) => ({ from: sq(s.slice(0, 2)), to: sq(s.slice(2)) }))) assert.ok(e.move(m.from, m.to));
  assert.deepEqual(e.history.filter((m) => m.piece.side === 'r').map((m) => m.check), [true, true, true]);
  const clips = highlights(fen, plies(e));
  ordered(clips);
  assert.ok(clips.some((c) => c.reason === '连将'), JSON.stringify(clips));
}

console.log('reel tests passed');
