// One-line commentary on notable AI moves, judged from what the search already reports (its score,
// a found mate) plus a one-ply look at whether the moved piece was left to be taken.
import { Engine, type PType, type Side } from './engine.ts';
import type { Style } from './ai.ts';
import { fenOf } from './record.ts';

export const STYLE_NAME: Record<Style, string> = { balanced: '均衡', aggressive: '猛攻', solid: '稳健' };
export const SIDE_NAME: Record<Side, string> = { r: '红方', b: '黑方' };
export type Moment = 'mate' | 'doomed' | 'sacrifice' | 'surge' | 'edge' | 'slump' | 'strain' | 'trade';

const MATE = 30000;
const VAL: Record<PType, number> = { K: 0, A: 120, B: 120, N: 270, R: 600, C: 285, P: 30 };
const CN = '一二三四五六七八九十';

/**
 * Material the side that just moved to `to` stands to lose there: the best the opponent gains by
 * taking the piece, counting one recapture. `e` is the position after the move (it is not changed).
 */
export function exposed(e: Engine, to: number): number {
  const t = new Engine(fenOf(e.board, e.turn));
  const p = t.board[to];
  if (!p) return 0;
  let worst = 0;
  for (const m of t.legalMoves()) {
    if (m.to !== to) continue;
    const attacker = t.board[m.from]!;
    t.move(m.from, m.to);
    const back = t.legalMoves().some((r) => r.to === to);
    t.undo();
    worst = Math.max(worst, VAL[p.type] - (back ? VAL[attacker.type] : 0));
  }
  return worst;
}

/** Value of the piece the last move took (0 for none). */
export const taken = (e: Engine) => { const c = e.history.at(-1)?.captured; return c ? VAL[c.type] : 0; };
/** Net material the last move left for the taking (what it gives up minus what it captured). */
export function sacrificed(e: Engine): number {
  const m = e.history.at(-1);
  return m ? exposed(e, m.to) - (m.captured ? VAL[m.captured.type] : 0) : 0;
}

/** What the search said about an AI move, and what the move did. */
export interface Verdict {
  /** The search's score for the mover after it, and on its previous searched move (null: none yet). */
  score: number; prev: number | null;
  /** Material left en prise net of any capture (see sacrificed), and the value of the piece taken. */
  given: number; taken: number;
  /** Plies since the last remark in this game. */
  since: number;
}
/**
 * What, if anything, is worth a remark about an AI move. `told` holds the moments already remarked
 * for this side this game: mate, doom, edge and strain are said once. Apart from a found mate,
 * remarks keep at least six plies apart, and the commonest (a level trade) twelve.
 */
export function judge(v: Verdict, told: Set<Moment>): Moment | null {
  const { score, prev, given, taken, since } = v;
  if (score > MATE - 200) return told.has('mate') ? null : 'mate';
  if (told.has('doomed') || since < 6) return null; // nothing more to say for a side that is lost
  if (score < -MATE + 200) return 'doomed';
  if (given >= 200 && score >= 150) return 'sacrifice';
  if (prev === null || Math.abs(prev) >= MATE - 200) return null;
  if (score - prev >= 250 && score >= 200) return 'surge';
  if (prev - score >= 250 && score <= -200) return 'slump';
  if (prev < 250 && score >= 250 && !told.has('edge')) return 'edge'; // the advantage first becomes clear
  if (prev > -250 && score <= -250 && !told.has('strain')) return 'strain';
  if (taken >= 270 && Math.abs(score) < 80 && since >= 12) return 'trade';
  return null;
}
/** Moves to mate from a mate score. */
export const mateIn = (score: number) => Math.max(1, Math.ceil((MATE - score) / 2));

const POOL: Record<Moment, Partial<Record<Style, string[]>> & { all: string[] }> = {
  mate: {
    all: ['{n}步之内，胜负已分', '大势已成，{n}着之内见分晓'],
    aggressive: ['杀机已现，{n}步之内取其首级', '铁骑叩关，{n}着之内必破中军'],
    solid: ['步步为营，{n}着之后大局可定', '稳扎稳打，{n}步之内收官'],
    balanced: ['胜机已握，{n}着可定乾坤'],
  },
  doomed: { all: ['大势已去，回天乏术', '城门已破，困兽犹斗', '将星摇落，败局已定'] },
  sacrifice: {
    all: ['弃子争先，一着惊人'],
    aggressive: ['弃子抢攻，以命换势', '置之死地而后生', '宁失一子，不失一先'],
    solid: ['舍小就大，静待其变', '暗弃一子，意在全局'],
    balanced: ['舍得一子，赢得全局', '欲擒故纵，此子不要也罢'],
  },
  surge: {
    all: ['一着不慎，满盘皆输', '敌方失算，此消彼长'],
    aggressive: ['敌露破绽，乘胜追击', '良机稍纵即逝，岂能放过'],
    solid: ['对手失着，形势转优', '敌乱我稳，优势在握'],
    balanced: ['形势陡转，优势渐显'],
  },
  edge: {
    all: ['大局渐明，胜势已成', '步步紧逼，优势渐扩'],
    aggressive: ['攻势如潮，敌阵摇摇欲坠', '兵临城下，只待破城'],
    solid: ['稳中求胜，优势在握', '积小胜为大胜'],
    balanced: ['胜势初成，且看如何收官'],
  },
  strain: {
    all: ['局面吃紧，需谨慎应对', '形势不利，且守且看'],
    aggressive: ['以攻代守，尚有一搏'],
    solid: ['固守待援，伺机反击'],
  },
  trade: {
    all: ['以子易子，旗鼓相当', '针锋相对，各不相让'],
    aggressive: ['短兵相接，寸土必争'],
    solid: ['兑子求稳，以简驭繁'],
    balanced: ['你来我往，势均力敌'],
  },
  slump: { all: ['形势急转直下', '一招失算，局面吃紧', '风云突变，危机四伏'] },
};
const lastLine = new Map<Moment, string>();
/** A line for the moment in the mover's style, never the same as the last one for that moment. */
export function line(m: Moment, style: Style, score: number, rnd = Math.random): string {
  const pool = [...POOL[m].all, ...(POOL[m][style] ?? []), ...(POOL[m][style] ?? [])].filter((s, _, a) => s !== lastLine.get(m) || a.length === 1);
  const s = pool[(rnd() * pool.length) | 0];
  lastLine.set(m, s);
  const n = mateIn(score);
  return s.replace('{n}', n <= 10 ? CN[n - 1] : String(n));
}
