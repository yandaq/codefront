import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import { scan, blameTree } from '@grim-repo/core';
import { ScanRequestSchema, type ProgressMessage, type Snapshot } from '@grim-repo/schema';

export interface ServerOptions { port?: number; host?: string; defaultPath?: string; webRoot?: string }

function resolveWebRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const dir = path.join(path.dirname(require.resolve('@grim-repo/web/package.json')), 'dist');
    return existsSync(dir) ? dir : null;
  } catch { return null; }
}

export async function startServer(opts: ServerOptions = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWs);
  const listeners = new Set<(p: ProgressMessage) => void>();
  const send = (m: ProgressMessage) => listeners.forEach((l) => l(m));
  const blaming = new Map<string, Record<string, number>>(); // root -> ages delivered so far
  const cache = new Map<string, Snapshot>();

  const doScan = async (p: string, showDocs = false, coverageReport?: string) => {
    const abs = path.resolve(p);
    const key = `${abs}|${showDocs}|${coverageReport ?? ''}`;
    const snap = await scan(abs, { showDocs, coverageReport, onProgress: (pr) => send({ ...pr, root: abs }) });
    cache.set(key, snap);
    // Background per-function age via git blame, streamed as layer updates after the scan returns.
    if (snap.git?.available) {
      const acc: Record<string, number> = {};
      blaming.set(abs, acc);
      setImmediate(() => {
        blameTree(abs, snap.root, (values, done, total) => {
          Object.assign(acc, values);
          send({ type: 'layer', layer: 'age', root: abs, values, done, total });
        }).catch(() => {});
      });
    }
    return snap;
  };

  app.get('/api/config', async () => ({ defaultPath: opts.defaultPath ?? null }));
  app.post('/api/scan', async (req, reply) => {
    const parsed = ScanRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!existsSync(parsed.data.path)) return reply.code(404).send({ error: `Path not found: ${parsed.data.path}` });
    return doScan(parsed.data.path, parsed.data.showDocs, parsed.data.coverageReport);
  });
  app.get<{ Querystring: { path?: string; showDocs?: string; coverageReport?: string } }>('/api/scan', async (req, reply) => {
    const p = req.query.path ?? opts.defaultPath;
    if (!p) return reply.code(400).send({ error: 'path required' });
    if (!existsSync(p)) return reply.code(404).send({ error: `Path not found: ${p}` });
    return doScan(p, req.query.showDocs === 'true', req.query.coverageReport);
  });
  app.get<{ Querystring: { path?: string } }>('/api/layers/age', async (req) => blaming.get(path.resolve(req.query.path ?? '')) ?? {});
  // Progress stream (M1 stub: broadcasts stage events of any running scan).
  app.get('/api/progress', { websocket: true }, (socket) => {
    const l = (p: ProgressMessage) => socket.send(JSON.stringify(p));
    listeners.add(l);
    socket.on('close', () => listeners.delete(l));
  });

  const webRoot = opts.webRoot ?? resolveWebRoot();
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }

  const address = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  return { app, address, close: () => app.close() };
}
