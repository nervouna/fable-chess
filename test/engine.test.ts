// Run with: npm test  (Node >= 23 strips TypeScript types natively)
import assert from 'node:assert/strict';
import { Engine, sq, sqName } from '../src/engine.ts';

const dests = (e: Engine, from: string) => e.legalFrom(sq(from)).map(sqName).sort();

// Perft from the opening position (widely published values).
{
  const e = new Engine();
  assert.equal(e.perft(1), 44);
  assert.equal(e.perft(2), 1920);
  assert.equal(e.perft(3), 79666);
}

// Hobbled horse: a piece on the adjacent orthogonal square blocks both moves in that direction.
{
  const e = new Engine('4k4/9/9/9/9/9/9/4P4/4N4/5K3 w');
  assert.deepEqual(dests(e, 'e1'), ['c0', 'c2', 'g0', 'g2']);
}

// Blocked elephant eye, and elephants cannot cross the river.
{
  const e = new Engine('4k4/9/9/9/9/2B6/3P5/9/9/5K3 w');
  assert.deepEqual(dests(e, 'c4'), ['a2']); // e2 is blocked by the pawn on the d3 eye
}

// Cannon needs exactly one screen to capture.
{
  const e = new Engine('3k5/9/9/4p4/9/4p4/9/4C4/9/4K4 w');
  assert.ok(dests(e, 'e2').includes('e6')); // jumps e4, captures e6
  assert.ok(!dests(e, 'e2').includes('e4')); // cannot capture without a screen
  assert.ok(dests(e, 'e2').includes('e3'));
}

// Flying general: the only piece between the kings is pinned to the file.
{
  const e = new Engine('4k4/9/9/9/9/9/9/4R4/9/4K4 w');
  assert.ok(dests(e, 'e2').every((s) => s[0] === 'e'));
}

// Cannot move into check; king confined to palace.
{
  const e = new Engine('3k5/9/9/9/9/9/9/9/5r3/4K4 w');
  assert.deepEqual(dests(e, 'e0'), []); // e1/f0 are covered by the rook, d0 would face the black king
}

// Pawn gains sideways moves only after crossing the river.
{
  const e = new Engine('3k5/9/9/9/2P6/9/P8/9/9/4K4 w');
  assert.deepEqual(dests(e, 'a3'), ['a4']);
  assert.deepEqual(dests(e, 'c5'), ['b5', 'c6', 'd5']);
}

// Checkmate and stalemate both lose for the side to move.
{
  const mate = new Engine('3k5/9/9/9/3R5/4R4/9/9/9/5K3 b');
  const s = mate.status();
  assert.deepEqual([s.check, s.over, s.winner, s.reason], [true, true, 'r', 'checkmate']);
  const stale = new Engine('3k5/4R4/9/9/9/9/9/9/9/2R1K4 b');
  const t = stale.status();
  assert.deepEqual([t.check, t.over, t.winner, t.reason], [false, true, 'r', 'stalemate']);
}

// Notation and undo.
{
  const e = new Engine();
  const m = e.move(sq('h2'), sq('e2'))!;
  assert.equal(m.notation, '炮二平五');
  assert.equal(e.move(sq('h9'), sq('g7'))!.notation, '马8进7');
  assert.equal(e.move(sq('e2'), sq('e6'))!.captured!.type, 'P');
  e.undo();
  assert.equal(e.board[sq('e6')]!.type, 'P');
  assert.equal(e.turn, 'r');
  assert.equal(e.move(sq('a0'), sq('a5')), null); // blocked by own pawn
}

console.log('engine tests passed');
