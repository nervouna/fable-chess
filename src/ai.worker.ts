// Runs the search off the main thread so animation never stalls while the AI thinks.
import { search, type AiRequest } from './ai';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; req: AiRequest }>) => void) | null; postMessage(m: unknown): void };
ctx.onmessage = (e) => ctx.postMessage({ id: e.data.id, res: search(e.data.req) });
