// Army morale as a pure function of the position: the reserves behind each back rank read it.
import type { Piece, PType, Side } from './engine';

/** Rough material value of each piece type (the general is priceless and not counted). */
export const VALUE: Record<PType, number> = { K: 0, A: 2, B: 2, N: 4, C: 4.5, R: 9, P: 1 };
/** Material each side starts with. */
export const FULL = 5 * VALUE.P + 2 * (VALUE.A + VALUE.B + VALUE.N + VALUE.C + VALUE.R);

export function material(board: readonly (Piece | null)[]): Record<Side, number> {
  const m = { r: 0, b: 0 };
  for (const p of board) if (p) m[p.side] += VALUE[p.type];
  return m;
}

/**
 * Morale of both armies in 0..1. Level material reads 0.6 (ready for battle); every point of advantage
 * lifts one side and sinks the other, and a side bled of its own pieces sags a little more.
 */
export function morale(board: readonly (Piece | null)[]): Record<Side, number> {
  const m = material(board), c = (v: number) => Math.min(1, Math.max(0, v));
  const one = (me: number, them: number) => c(0.6 + (1.25 * (me - them)) / FULL - 0.2 * (1 - Math.min(1, me / FULL)));
  return { r: one(m.r, m.b), b: one(m.b, m.r) };
}
