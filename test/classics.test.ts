// Run with: npm test
import assert from 'node:assert/strict';
import { sqName } from '../src/engine.ts';
import { CLASSICS, classicRecord } from '../src/classics.ts';
import { decode, encode } from '../src/record.ts';

// Each classic plays through the engine to the end its source gives: pinned length and last move, and
// for the lines that end in mate, the engine agrees who mated whom. None may end early or run on.
const PINNED: [plies: number, last: string][] = [
  [25, '炮八平五'], [41, '炮八进一'], [35, '车五平四'], [33, '前车平五'], [14, '象3进5'], [38, '车4退3'], [29, '炮三平五'],
];
assert.equal(CLASSICS.length, PINNED.length);
assert.equal(new Set(CLASSICS.map((c) => c.title)).size, CLASSICS.length, 'titles are distinct');
CLASSICS.forEach((c, i) => {
  const rec = classicRecord(c), e = rec.engine, st = e.status();
  assert.deepEqual([rec.moves.length, e.history.at(-1)!.notation], PINNED[i], c.title);
  if (c.end) assert.deepEqual([st.over, st.reason, st.winner], [true, c.end.reason, c.end.winner], c.title);
  else assert.equal(st.over, false, c.title);
  // A classic shares as an ordinary #g= link that decodes to the same game.
  const back = decode(encode(e));
  assert.deepEqual(back.moves.map((m) => sqName(m.from) + sqName(m.to)), rec.moves.map((m) => sqName(m.from) + sqName(m.to)), c.title);
  assert.ok(c.title && c.source && c.blurb, c.title);
});
console.log(`classics: ${CLASSICS.length} games, ${CLASSICS.reduce((n, c) => n + classicRecord(c).moves.length, 0)} plies, all legal`);
console.log('classics tests passed');
