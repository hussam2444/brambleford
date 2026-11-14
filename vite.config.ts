import { defineConfig, loadEnv, type Plugin } from 'vite';

/** In development, serve /api/* from `server/near.ts`, the same code the hosted functions use. */
function api(): Plugin {
  return {
    name: 'brambleford-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* treated as empty */ }
        const env = loadEnv(server.config.mode, process.cwd(), '');
        const { handle } = await server.ssrLoadModule('/server/near.ts');
        const route = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const { status, json } = req.method === 'POST' ? await handle(route, body, env) : { status: 405, json: { error: 'Use POST.' } };
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
      });
    },
  };
}

// A fixed port, so `npm run test:api` knows where to find the dev server.
export default defineConfig({ plugins: [api()], server: { port: 5183 } });
