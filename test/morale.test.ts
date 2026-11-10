// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN } from '../src/engine.ts';
import { FULL, material, morale } from '../src/morale.ts';

const at = (fen: string) => morale(new Engine(fen).board);

// The opening: full material, level and ready.
const e = new Engine(START_FEN);
assert.deepEqual(material(e.board), { r: FULL, b: FULL });
const m0 = morale(e.board);
assert.equal(m0.r, m0.b);
assert.ok(Math.abs(m0.r - 0.6) < 1e-9, 'level material reads 0.6');

// Losing a chariot hurts; the side that took it rises by as much as the other falls (plus its own loss).
const down = at('rnbakabn1/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w');
assert.ok(down.r > m0.r && down.b < m0.b, 'red up a chariot: red rises, black sinks');
assert.ok(down.r - m0.r < m0.b - down.b, 'the losing side also sags for its own loss');

// Lopsided: black has only its general and two pawns left.
const lop = at('4k4/9/9/p7p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w');
assert.equal(lop.r, 1);
assert.equal(lop.b, 0);

// Symmetric and always in range.
const mirror = at('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/1NBAKABNR w');
assert.ok(Math.abs(mirror.b - down.r) < 1e-9 && Math.abs(mirror.r - down.b) < 1e-9, 'morale is colour-blind');
for (const v of [down.r, down.b, mirror.r, mirror.b]) assert.ok(v >= 0 && v <= 1);

console.log('morale tests passed');
