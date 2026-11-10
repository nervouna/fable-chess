// Highlight reel: score every ply of a game and cut the best moments into a short list of clips.
// Pure (no rendering), so it runs in Node for tests.
//
// Plies are counted like replay positions: position n is the board after n moves, and the move that
// leads to it is ply n (1-based). A clip shows positions start..end: it seeks to `start` instantly,
// then animates moves start+1..end. `ply` is its key move, `start` < ply <= `end`.
//
// Signals, each a candidate segment of one or more plies:
//   capture        10 x piece value (chariot 9, cannon 4.5, horse 4, elephant / advisor 2, pawn 1)
//   check          +25 (a capture that also checks gets both)
//   first blood    +20 on the game's first capture
//   exchange       a capture answered at once by a recapture on the same square: both plies, +15
//   sacrifice      a move that hands over more than it took, accepted at once on that square, after
//                  which the sacrificing side checks on its very next move: both plies, +40 + 8 x value
//   king hunt      three or more checks in a row by one side: the run (last 5 plies at most), +30 each
//   mate           checkmate or stalemate on the last move: always included, always last
// Candidates are taken by score (ties: the later moment) while they do not overlap a chosen one and
// the estimated running time stays inside the budget. Then each clip gets up to two quiet lead-in plies
// (no capture, no check) that do not reach into the clip before it; one is budgeted, the second is
// taken only while the budget allows.
import { Engine, type Move, type PType, type Side } from './engine.ts';
import type { Ply } from './record.ts';

export interface Clip {
  /** key move (1-based ply) */ ply: number;
  /** first position shown (instant) */ start: number;
  /** last position (after the clip's final move) */ end: number;
  score: number; reason: string; side: Side; notation: string;
}
export interface ReelOptions { /** at most this many clips */ max?: number; /** estimated seconds of reel */ seconds?: number }

export const REEL_MAX_CLIPS = 7, REEL_SECONDS = 60;
export const VALUE: Record<PType, number> = { K: 0, R: 9, C: 4.5, N: 4, B: 2, A: 2, P: 1 };
const TAKE: Record<PType, string> = { K: '擒王', R: '斩车', C: '夺炮', N: '擒马', B: '破象', A: '破士', P: '吃卒' };
const SAC: Record<PType, string> = { K: '弃帅', R: '弃车', C: '弃炮', N: '弃马', B: '弃象', A: '弃士', P: '弃兵' };
const SWAP: Record<PType, string> = { K: '兑子', R: '兑车', C: '兑炮', N: '兑马', B: '兑象', A: '兑士', P: '兑兵' };

/** Rough real seconds a move takes on screen: duels are long, the final blow longer still. */
export function plySeconds(m: Move, last = false): number {
  return (m.captured ? 4.6 : 1.4) + (m.check ? 0.8 : 0) + (last ? 4.5 : 0);
}
/** Per-clip overhead: the title card before the move and the beat after it. */
export const CLIP_SECONDS = 1.6, LEAD_SECONDS = 1.4;

interface Cand { ply: number; start: number; end: number; score: number; reason: string; forced?: boolean }

/** Score every ply of `moves` played from `fen` and pick the highlights, in game order. */
export function highlights(fen: string, moves: Ply[], o: ReelOptions = {}): Clip[] {
  const max = o.max ?? REEL_MAX_CLIPS, budget = o.seconds ?? REEL_SECONDS;
  const e = new Engine(fen);
  for (const m of moves) if (!e.move(m.from, m.to)) throw new Error('illegal move in reel source');
  const h = e.history, n = h.length;
  if (!n) return [];
  const st = e.status(), mate = st.over && (st.reason === 'checkmate' || st.reason === 'stalemate');
  const at = (p: number) => h[p - 1]; // move of ply p
  const firstCap = h.findIndex((m) => m.captured) + 1;
  const single = (p: number) => { const m = at(p); return (m.captured ? 10 * VALUE[m.captured.type] : 0) + (m.check ? 25 : 0) + (p === firstCap ? 20 : 0); };
  const cands: Cand[] = [];
  for (let p = 1; p <= n; p++) {
    const m = at(p), s = single(p);
    if (p === n && mate) { cands.push({ ply: p, start: p - 1, end: p, score: 1000 + s, reason: st.reason === 'checkmate' ? '绝杀' : '困毙', forced: true }); continue; }
    if (s > 0) cands.push({ ply: p, start: p - 1, end: p, score: s, reason: m.captured ? (m.captured.type !== 'R' && p === firstCap ? '首开杀戒' : TAKE[m.captured.type]) : '将军' });
    const r = p < n ? at(p + 1) : null;
    if (r?.captured && r.to === m.to && !(p + 1 === n && mate)) {
      const lost = VALUE[m.piece.type], won = m.captured ? VALUE[m.captured.type] : 0, next = p + 2 <= n ? at(p + 2) : null;
      if (m.captured) cands.push({ ply: p, start: p - 1, end: p + 1, score: s + single(p + 1) + 15, reason: m.captured.type === m.piece.type ? SWAP[m.piece.type] : '兑子' });
      else if (lost - won >= 2 && next?.check) cands.push({ ply: p, start: p - 1, end: p + 1, score: s + single(p + 1) + 40 + 8 * lost, reason: SAC[m.piece.type] });
    }
  }
  // King hunts: maximal runs of checks by one side on consecutive turns, stopping short of a mate.
  for (let p = 1; p <= n; p++) {
    if (!at(p).check || (p > 2 && at(p - 2).check)) continue;
    let q = p;
    while (q + 2 <= n && at(q + 2).check && !(q + 2 === n && mate)) q += 2;
    if (q === n && mate) q -= 2;
    const checks = (q - p) / 2 + 1;
    if (checks < 3) continue;
    const start = Math.max(p - 1, q - 5);
    let score = 30 * checks;
    for (let k = start + 1; k <= q; k++) score += at(k).captured ? 10 * VALUE[at(k).captured!.type] : 0;
    cands.push({ ply: q, start, end: q, score, reason: '连将' });
  }
  cands.sort((a, b) => Number(!!b.forced) - Number(!!a.forced) || b.score - a.score || b.ply - a.ply || a.start - b.start);
  const secs = (c: Cand) => { let t = CLIP_SECONDS + LEAD_SECONDS; for (let k = c.start + 1; k <= c.end; k++) t += plySeconds(at(k), k === n && mate); return t; };
  const picked: Cand[] = [];
  let total = 0;
  for (const c of cands) {
    if (picked.length >= max) break;
    if (picked.some((d) => c.start < d.end && d.start < c.end)) continue;
    const t = secs(c);
    if (!c.forced && picked.length && total + t > budget) continue;
    picked.push(c); total += t;
  }
  if (!picked.length) picked.push({ ply: n, start: n - 1, end: n, score: 0, reason: '收官' });
  picked.sort((a, b) => a.start - b.start);
  // Lead-ins: one or two quiet moves before the clip, for context.
  let prevEnd = 0;
  return picked.map((c) => {
    let start = c.start;
    while (start > prevEnd && c.start - start < 2 && !at(start).captured && !at(start).check) {
      if (c.start - start === 1) { if (total + LEAD_SECONDS > budget) break; total += LEAD_SECONDS; }
      start--;
    }
    prevEnd = c.end;
    const m = at(c.ply);
    return { ply: c.ply, start, end: c.end, score: c.score, reason: c.reason, side: m.piece.side, notation: m.notation };
  });
}
