// Hosted entry point (Vercel): /api/join, /api/relay, /api/tick.
import { handle, methodAllowed, type ServerEnv } from '../server/near.js';

interface Req { method?: string; query: Record<string, string | string[]>; body?: unknown; headers: Record<string, string | string[] | undefined> }
interface Res { status(code: number): Res; json(body: unknown): void; setHeader(name: string, value: string): unknown }

export default async function handler(req: Req, res: Res) {
  const route = String(req.query.route);
  // Everything is POST. The clock also answers GET, because that is what Vercel's timer sends ("crons" in vercel.json).
  if (!methodAllowed(route, req.method)) return res.status(405).json({ error: 'Use POST.' });
  res.setHeader('Cache-Control', 'no-store'); // an answer kept by a cache would leave the timer nudging nothing
  const who = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
  const { status, json } = await handle(route, req.body, process.env as ServerEnv, who, req.method);
  res.status(status).json(json);
}
