// Runs the search off the main thread so animation never stalls while the AI thinks.
// With `book`, a position still in the opening book is answered from it at once.
import { search, type AiRequest, type AiResult } from './ai';
import { bookPick } from './book';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; req: AiRequest }>) => void) | null; postMessage(m: unknown): void };
ctx.onmessage = (e) => {
  const req = e.data.req, b = req.book ? bookPick(req.board, req.turn, req.style) : null;
  const res: AiResult | null = b ? { from: b.from, to: b.to, score: 0, depth: 0, nodes: 0, book: true } : search(req);
  ctx.postMessage({ id: e.data.id, res });
};
