// Style match: each style against balanced at equal fixed depth, alternating colours. Openings come
// from the book (weighted per style), so games differ. Slow; not part of `npm test`.
// Run with: node tools/match.ts [games=20] [depth=3] [styles=aggressive,solid]
import { Engine, sqName } from '../src/engine.ts';
import { encode, hashBoard, search, type Style } from '../src/ai.ts';
import { bookPick } from '../src/book.ts';

const GAMES = +(process.argv[2] ?? 20), DEPTH = +(process.argv[3] ?? 3), CAP = 300;
const styles = (process.argv[4] ?? 'aggressive,solid').split(',') as Style[];

function game(red: Style, black: Style) {
  const e = new Engine(), reps: number[] = [];
  let st = e.status();
  while (!st.over && e.history.length < CAP) {
    const board = encode(e.board), turn = e.turn === 'r' ? 0 : 1, style = turn ? black : red;
    const b = bookPick(board, turn, style);
    const r = b ?? search({ board, turn, reps, depth: DEPTH, style })!;
    reps.push(hashBoard(board, turn));
    if (!e.move(r.from, r.to)) throw new Error(`illegal ${sqName(r.from)}${sqName(r.to)}`);
    st = e.status();
  }
  return { winner: st.over ? st.winner : null, reason: st.over ? st.reason : 'cap', plies: e.history.length };
}

for (const s of styles) {
  const t0 = Date.now(), score = { win: 0, draw: 0, loss: 0 }, reasons: Record<string, number> = {};
  let plies = 0;
  for (let g = 0; g < GAMES; g++) {
    const asRed = g % 2 === 0, r = game(asRed ? s : 'balanced', asRed ? 'balanced' : s);
    const mine = asRed ? 'r' : 'b';
    score[r.winner === null ? 'draw' : r.winner === mine ? 'win' : 'loss']++;
    reasons[r.reason!] = (reasons[r.reason!] ?? 0) + 1; plies += r.plies;
  }
  console.log(`${s} vs balanced, depth ${DEPTH}, ${GAMES} games: W ${score.win} / D ${score.draw} / L ${score.loss}  ${JSON.stringify(reasons)}  avg ${Math.round(plies / GAMES)} plies  ${Math.round((Date.now() - t0) / 1000)} s`);
}
