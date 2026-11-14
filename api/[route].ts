// Hosted entry point (Vercel): /api/join, /api/relay, /api/tick.
import { handle, type ServerEnv } from '../server/near.js';

interface Req { method?: string; query: Record<string, string | string[]>; body?: unknown; headers: Record<string, string | string[] | undefined> }
interface Res { status(code: number): Res; json(body: unknown): void }

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const who = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
  const { status, json } = await handle(String(req.query.route), req.body, process.env as ServerEnv, who);
  res.status(status).json(json);
}
