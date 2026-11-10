// Run with: npm test
import assert from 'node:assert/strict';
import { Engine, START_FEN, sq, sqName } from '../src/engine.ts';
import { NotationError, notationTokens, parseMove, traditional } from '../src/notation.ts';
import { RecordError, decode } from '../src/record.ts';

const iccs = (m: { from: number; to: number }) => sqName(m.from) + sqName(m.to);
const parse = (e: Engine, s: string) => iccs(parseMove(e, s));
const name = (e: Engine, m: string) => e.notate(sq(m.slice(0, 2)), sq(m.slice(2)));
const rng = (seed: number) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000); };

// Round trip: every legal move of every position along seeded random games reads back as itself, in
// the generator's spelling and in traditional glyphs with full-width digits.
{
  // Varied starts: the opening, and crowded pawn files (three, four and five on a file, two files of
  // several pawns each) that ordinary games rarely reach.
  const starts = [
    START_FEN,
    '3akab2/9/4P4/2P1P1P2/4P4/9/9/9/4A4/4K4 w', // five red pawns, three on the centre file
    '4k4/9/9/2p3p2/2p3p2/2P3P2/2P3P2/9/9/3K5 w', // two files of two pawns each, both sides
    '3k5/9/9/3P1P3/3P1P3/4P4/9/9/9/4K4 w', // two files of two red pawns, one more between
    'r1bakab1r/9/1cn1c1n2/p1p1p1p1p/9/2P1P1P2/P3P3P/1C2C2C1/9/RNBAKABNR w', // doubled cannons and pawns (illegal army, legal moves)
    '2bakab2/9/9/4p4/4p4/4p4/9/9/4A4/3AK4 b', // three black pawns on a file
  ];
  let moves = 0, tagged = 0, numbered = 0;
  for (let g = 0; g < 36; g++) {
    const e = new Engine(starts[g % starts.length]), rnd = rng(1000 + g);
    for (let ply = 0; ply < 70 && !e.status().over; ply++) {
      for (const m of e.legalMoves()) {
        const s = e.notate(m.from, m.to);
        assert.equal(parse(e, s), iccs(m), `${s} in ${e.key()}`);
        assert.equal(parse(e, traditional(s)), iccs(m), traditional(s));
        moves++;
        if (/^[前中后]/.test(s)) tagged++;
        if (/^[一二三四五][兵卒]/.test(s)) numbered++;
      }
      const all = e.legalMoves(), caps = all.filter((m) => e.board[m.to]);
      const pick = caps.length && rnd() < 0.3 ? caps : all, m = pick[(rnd() * pick.length) | 0];
      e.move(m.from, m.to);
    }
  }
  assert.ok(moves >= 20000, `only ${moves} moves checked`);
  assert.ok(tagged > 500 && numbered > 100, `tagged ${tagged}, numbered ${numbered}`);
  console.log(`notation round trip: ${moves} moves, ${tagged} with 前/中/后, ${numbered} numbered pawns, 0 mismatches`);
}

// 前/后: two pieces of a kind on one file, for both sides (front = nearer the enemy).
{
  const e = new Engine('r1bakab1r/9/1c2c4/p1p1p1p1p/9/9/P1P1P1P1P/4C4/4C4/RNBAKABNR w');
  // Red cannons on e2 (front) and e1 (back).
  assert.equal(name(e, 'e2e6'), '前炮进四');
  assert.equal(name(e, 'e1f1'), '后炮平四');
  assert.equal(parse(e, '前炮进四'), 'e2e6');
  assert.equal(parse(e, '后炮平四'), 'e1f1');
  assert.equal(parse(e, '後砲平四'), 'e1f1');
  assert.equal(parse(e, '炮五进四'), 'e2e6'); // the plain form, when only one of the two can make the move
  assert.throws(() => parseMove(e, '炮五平四'), /ambiguous/); // either cannon could
  // Black cannons on e4 (front: black advances down the board) and e7 (back).
  e.load('r1bakab1r/9/4c4/p1p1p1p1p/9/4c4/P1P1P1P1P/4C4/9/RNBAKABNR b');
  assert.equal(name(e, 'e4e5'), '前炮退1');
  assert.equal(name(e, 'e4d4'), '前炮平4');
  assert.equal(name(e, 'e7d7'), '后炮平4');
  assert.equal(parse(e, '前炮退１'), 'e4e5');
  assert.equal(parse(e, '後包平4'), 'e7d7');
  assert.throws(() => parseMove(e, '炮5平4'), /ambiguous/);
}

// Pawns: three on a file (前/中/后, or 一二三), four and five (一二三四五, 前…后), and two files of
// several pawns, numbered together: files in the side's own order, each front to back.
{
  const e = new Engine('3k5/9/2P1P4/2P1P4/2P6/9/9/9/9/4K4 w');
  // c7 c6 c5 on file 七, e7 e6 on file 五: two crowded files, so all five are numbered, file 五 first.
  const five = ['e7e8', 'e6d6', 'c7c8', 'c6b6', 'c5d5'];
  assert.deepEqual(five.map((m) => name(e, m)), ['一兵进一', '二兵平六', '三兵进一', '四兵平八', '五兵平六']);
  for (const m of five) assert.equal(parse(e, name(e, m)), m);
  assert.equal(parse(e, '前兵五进一'), 'e7e8'); // the traditional five-character form
  assert.equal(parse(e, '前五进一'), 'e7e8'); // and its four-character abbreviation
  assert.equal(parse(e, '中兵七平八'), 'c6b6');

  e.load('3k5/9/2P6/2P6/2P6/9/9/9/9/4K4 w'); // three on file 七 alone
  assert.deepEqual(['c7c8', 'c6d6', 'c5b5'].map((m) => name(e, m)), ['前兵进一', '中兵平六', '后兵平八']);
  assert.equal(parse(e, '中兵平六'), 'c6d6');
  assert.equal(parse(e, '二兵平六'), 'c6d6');
  assert.equal(parse(e, '後兵平八'), 'c5b5');

  e.load('3k5/2P6/2P6/2P6/2P6/9/9/9/9/4K4 w'); // four on file 七
  assert.deepEqual(['c8c9', 'c7d7', 'c6b6', 'c5d5'].map((m) => name(e, m)), ['一兵进一', '二兵平六', '三兵平八', '四兵平六']);
  assert.equal(parse(e, '前兵进一'), 'c8c9');
  assert.equal(parse(e, '后兵平六'), 'c5d5');

  // The example of the xqbase notation standard: pawns on files 四 and 六 (f8 f6 d8 d6) and one on e7.
  e.load('4k4/3P1P3/4P4/3P1P3/9/9/9/9/9/4K4 w');
  assert.deepEqual(['f8e8', 'f6e6', 'e7e8', 'd8e8', 'd6e6'].map((m) => name(e, m)), ['一兵平五', '二兵平五', '兵五进一', '三兵平五', '四兵平五']);

  // Black counts its own way round: its file 1 is red's file 九, its front is toward red.
  e.load('4k4/9/9/9/9/p1p6/p1p6/9/9/3K5 b');
  assert.deepEqual(['a3a2', 'a4b4', 'c3c2', 'c4d4'].map((m) => name(e, m)), ['一卒进1', '二卒平2', '三卒进1', '四卒平4']);
  assert.equal(parse(e, '一卒平2'), 'a3b3');
  assert.equal(parse(e, '前卒1平2'), 'a3b3');
}

// Glyphs: traditional and simplified, either side's piece names, digits of any kind.
{
  const e = new Engine();
  for (const s of ['炮二平五', '炮２平５', '砲二平五', '炮2平5', '炮二平５']) assert.equal(parse(e, s), 'h2e2', s);
  for (const s of ['馬二進三', '傌二进三', '马二上三']) assert.equal(parse(e, s), 'h0g2', s);
  assert.equal(parse(e, '俥一進一'), 'i0i1');
  assert.equal(parse(e, '帥五進一'), 'e0e1');
  assert.equal(parse(e, '仕四進五'), 'f0e1');
  assert.equal(parse(e, '士四进五'), 'f0e1');
  assert.equal(parse(e, '相三進五'), 'g0e2');
  assert.equal(parse(e, '象三进五'), 'g0e2');
  assert.equal(parse(e, '兵七進一'), 'c3c4');
  assert.equal(parse(e, '卒七进一'), 'c3c4');
  e.move(sq('h2'), sq('e2'));
  for (const s of ['马8进7', '馬８進７', '馬八進七', '包8平5', '砲８平５', '將5進1']) assert.ok(parse(e, s), s);
  assert.equal(parse(e, '包8平5'), 'h7e7');
  assert.equal(parse(e, '將5進1'), 'e9e8');
  assert.equal(parse(e, '象7进5'), 'g9e7');
  assert.equal(traditional('马8进7'), '馬８進７');
  assert.equal(traditional('前车进一'), '前車進一');
}

// Rejection, with an error that says what was wrong.
{
  const e = new Engine();
  assert.throws(() => parseMove(e, 'hello'), (err: unknown) => err instanceof NotationError && /not a move/.test(err.message));
  assert.throws(() => parseMove(e, '车一进十'), NotationError);
  assert.throws(() => parseMove(e, '马二进五'), /not a legal move for red/); // horses do not go there
  assert.throws(() => parseMove(e, '将5平4'), /not a legal move for red/); // an advisor stands there
  assert.throws(() => parseMove(e, '车一平二'), /not a legal move/); // blocked by the horse
  assert.throws(() => parseMove(e, '前炮进四'), /not a legal move/); // no two cannons share a file
}

// Games in traditional notation decode like any other record; move numbers and comments are skipped.
{
  const want = decode('h2e2 h9g7 h0g2 i9h9').engine.key();
  for (const text of [
    '1. 炮二平五 马８进７ 2. 马二进三 车９平８',
    '1.炮二平五　馬８進７\n2.馬二進三　車９平８',
    '炮二平五 馬八進七（屏風馬）傌二進三 {comment: 兵三进一} 車九平八',
    '1.炮二平五马8进7 2.马二进三车9平8',
  ]) assert.equal(decode(text).engine.key(), want, text);
  assert.deepEqual(notationTokens('1. 炮二平五 (宜走兵三进一) 马８进７'), ['炮二平五', '马８进７']);
  // A PGN's [FEN] tag sets the start (here red gives a horse), and its other tags are skipped.
  const pgn = decode('[Game "Chinese Chess"]\n[FEN "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/R1BAKABNR w - - 0 1"]\n1. 炮二平五 炮８平５ 2. 马二进三');
  assert.equal(pgn.fen, 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/R1BAKABNR w');
  assert.equal(pgn.moves.length, 3);
  assert.throws(() => decode('1. 炮二平五 马８进７ 2. 马二进五'), (err: unknown) => err instanceof RecordError && /Move 3: "马二进五" is not a legal move/.test(err.message));
}
console.log('notation tests passed');
