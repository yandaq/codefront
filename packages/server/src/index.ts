import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { safeFilePath } from './safe.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import {
  scanTarget, blameTree, isGitUrl, parseGitUrl, localRepoId, RepoCache, listBranches, repoDir, liteSnapshot, findFile,
  loadKeytar, savePat, ignoreFilter, type ResolvedTarget,
} from '@grim-repo/core';
import { ScanRequestSchema, type ProgressMessage, type Snapshot, type ScanRequest } from '@grim-repo/schema';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

export interface ServerOptions { port?: number; host?: string; defaultPath?: string; webRoot?: string; liteFiles?: number; log?: (msg: string) => void }

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
  const log = opts.log ?? (() => {});
  const liteFiles = opts.liteFiles ?? Number(process.env.GRIM_LITE_FILES ?? 50_000);
  const listeners = new Set<(p: ProgressMessage) => void>();
  const send = (m: ProgressMessage) => listeners.forEach((l) => l(m));
  const blaming = new Map<string, Record<string, number>>(); // root -> ages delivered so far
  const snaps = new Map<string, Snapshot>(); // work-tree root -> full (non-lite) snapshot
  const targets = new Map<string, { input: string; req: ScanRequest; target: ResolvedTarget }>();
  const watchers = new Map<string, FSWatcher>();
  const inflight = new Map<string, Promise<Snapshot>>();

  const transport = (s: Snapshot) => (s.stats.files > liteFiles ? liteSnapshot(s) : s);

  const doScan = async (req: ScanRequest): Promise<Snapshot> => {
    const input = isGitUrl(req.path) ? req.path : path.resolve(req.path);
    const key = `${input}|${req.ref ?? ''}`;
    // coalesce concurrent scans of the same target
    const prev = inflight.get(key);
    if (prev) await prev.catch(() => {});
    const p = (async () => {
      const t0 = Date.now();
      const { snapshot: snap, target, cache } = await scanTarget(input, {
        ref: req.ref, fetch: req.fetch, showDocs: req.showDocs, coverageReport: req.coverageReport,
        onProgress: (pr) => send({ ...pr, root: input }),
        onPartial: (s) => send({ type: 'snapshot', root: input, partial: true, snapshot: transport(s) }),
      });
      log(`scan ${input}: ${snap.stats.files} files in ${Date.now() - t0}ms (cache ${snap.stats.cacheHits} hit / ${snap.stats.cacheMisses} miss)`);
      const abs = target.root;
      snaps.set(abs, snap);
      targets.set(abs, { input, req: { ...req, fetch: false }, target });
      // Background per-function age via git blame (cached by blob + HEAD), streamed as layer updates.
      if (snap.git?.available) {
        const acc: Record<string, number> = {};
        blaming.set(abs, acc);
        setImmediate(() => {
          send({ stage: 'blame', done: 0, total: 1, root: input });
          blameTree(abs, snap.root, (values, done, total) => {
            Object.assign(acc, values);
            send({ type: 'layer', layer: 'age', root: abs, values, done, total });
            send({ stage: 'blame', done, total, root: input });
          }, 4, cache?.blameCache(snap.git?.head)).then(() => cache?.saveBlame()).catch(() => {});
        });
      }
      return snap;
    })();
    inflight.set(key, p);
    try { return await p; } finally { if (inflight.get(key) === p) inflight.delete(key); }
  };

  const validTarget = (p: string) => isGitUrl(p) || existsSync(p);
  const fail = (e: unknown) => ({ error: String((e as Error)?.message ?? e) });

  app.get('/api/config', async () => ({ defaultPath: opts.defaultPath ?? null, keytar: !!(await loadKeytar()) }));
  app.post('/api/scan', async (req, reply) => {
    const parsed = ScanRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!validTarget(parsed.data.path)) return reply.code(404).send({ error: `Path not found: ${parsed.data.path}` });
    try { return transport(await doScan(parsed.data)); } catch (e) { return reply.code(500).send(fail(e)); }
  });
  app.get<{ Querystring: { path?: string; showDocs?: string; coverageReport?: string; ref?: string } }>('/api/scan', async (req, reply) => {
    const p = req.query.path ?? opts.defaultPath;
    if (!p) return reply.code(400).send({ error: 'path required' });
    if (!validTarget(p)) return reply.code(404).send({ error: `Path not found: ${p}` });
    try { return transport(await doScan({ path: p, showDocs: req.query.showDocs === 'true', coverageReport: req.query.coverageReport, ref: req.query.ref })); }
    catch (e) { return reply.code(500).send(fail(e)); }
  });
  // Instant reopen: last persisted snapshot for a target (no clone/scan); 404 if none.
  app.get<{ Querystring: { path?: string } }>('/api/cached', async (req, reply) => {
    const p = req.query.path;
    if (!p) return reply.code(400).send({ error: 'path required' });
    const id = isGitUrl(p) ? parseGitUrl(p).id : localRepoId(p);
    const s = await (await RepoCache.open(id)).loadSnapshot();
    if (!s || (!isGitUrl(p) && !existsSync(s.source.path))) return reply.code(404).send({ error: 'no cache' });
    if (!snaps.has(s.source.path)) snaps.set(s.source.path, s); // allows code peek before the refresh lands
    return transport(s);
  });
  app.get<{ Querystring: { path?: string } }>('/api/branches', async (req, reply) => {
    const p = req.query.path;
    if (!p || !isGitUrl(p)) return reply.code(400).send({ error: 'git URL required' });
    const dir = repoDir(parseGitUrl(p));
    if (!existsSync(dir)) return reply.code(404).send({ error: 'not cloned' });
    return { branches: await listBranches(dir) };
  });
  // Lazy per-file detail for large (lite) snapshots.
  app.get<{ Querystring: { root?: string; path?: string } }>('/api/detail', async (req, reply) => {
    const s = snaps.get(path.resolve(req.query.root ?? ''));
    const f = s && req.query.path ? findFile(s.root, req.query.path) : null;
    return f ?? reply.code(404).send({ error: 'not found' });
  });
  app.get('/api/auth', async () => ({ keytar: !!(await loadKeytar()) }));
  app.post<{ Body: { host?: string; token?: string } }>('/api/auth/pat', async (req, reply) => {
    const { host, token } = req.body ?? {};
    if (!host || !token) return reply.code(400).send({ error: 'host and token required' });
    if (!(await savePat(host.toLowerCase(), token))) return reply.code(501).send({ error: 'OS keychain unavailable (keytar failed to load); use gh auth login or a git credential helper' });
    return { ok: true };
  });
  // Watch mode (local repos only): chokidar → debounced incremental rescan, pushed as snapshot updates.
  app.post<{ Body: { root?: string; on?: boolean } }>('/api/watch', async (req, reply) => {
    const root = path.resolve(req.body?.root ?? '');
    const t = targets.get(root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    if (t.target.remote) return reply.code(400).send({ error: 'watch mode is for local repos only' });
    const existing = watchers.get(root);
    if (!req.body?.on) { await existing?.close(); watchers.delete(root); return { watching: false }; }
    if (existing) return { watching: true };
    const ignored = await ignoreFilter(root);
    const w = chokidarWatch(root, { ignored: (p: string) => ignored(p), ignoreInitial: true, awaitWriteFinish: false });
    let timer: NodeJS.Timeout | null = null;
    w.on('all', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        try { const s = await doScan(t.req); send({ type: 'snapshot', root: t.input, snapshot: transport(s) }); } catch (e) { log(`watch rescan failed: ${fail(e).error}`); }
      }, 500);
    });
    watchers.set(root, w);
    return { watching: true };
  });
  // Code peek: only files present in the snapshot of that root, never outside it.
  const filesOf = (abs: string) => {
    const s = new Set<string>();
    const snap = snaps.get(abs);
    const walk = (n: Snapshot['root']) => { if (n.kind === 'file') s.add(n.path); else n.children?.forEach(walk); };
    if (snap) walk(snap.root);
    return s;
  };
  app.get<{ Querystring: { root?: string; path?: string } }>('/api/file', async (req, reply) => {
    const { root, path: rel } = req.query;
    if (!root || !rel) return reply.code(400).send({ error: 'root and path required' });
    const abs = safeFilePath(root, rel, filesOf(path.resolve(root)));
    if (!abs) return reply.code(403).send({ error: 'forbidden' });
    const text = await readFile(abs, 'utf8');
    return reply.type('text/plain; charset=utf-8').send(text);
  });
  app.get<{ Querystring: { path?: string } }>('/api/layers/age', async (req) => blaming.get(path.resolve(req.query.path ?? '')) ?? {});
  // Progress stream: stage events, partial/refreshed snapshots and layer updates.
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
  app.addHook('onClose', async () => { await Promise.all([...watchers.values()].map((w) => w.close())); });

  const address = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  return { app, address, close: () => app.close() };
}
