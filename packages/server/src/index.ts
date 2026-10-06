import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { safeFilePath } from './safe.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import {
  scanTarget, blameTree, isGitUrl, parseGitUrl, localRepoId, RepoCache, listBranches, repoDir, liteSnapshot, findFile,
  loadKeytar, savePat, ignoreFilter, gitBranches, listCommits, diffRange, refShapeOk, EMPTY_TREE, fetchRemotes, listRemotes, type ResolvedTarget, type DiffResult,
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
  type WatchState = { watcher?: FSWatcher; ready: Promise<void>; stopped: boolean; scanTimer?: NodeJS.Timeout; restartTimer?: NodeJS.Timeout };
  const watchers = new Map<string, WatchState>();
  const inflight = new Map<string, Promise<Snapshot>>();

  const transport = (s: Snapshot) => (s.stats.files > liteFiles ? liteSnapshot(s) : s);

  const doScan = async (req: ScanRequest): Promise<Snapshot> => {
    const input = isGitUrl(req.path) ? req.path : path.resolve(req.path);
    const key = `${input}|${req.ref ?? ''}|docs:${req.showDocs !== false}`;
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
    const showDocs = req.query.showDocs == null ? undefined : req.query.showDocs === 'true';
    try { return transport(await doScan({ path: p, showDocs, coverageReport: req.query.coverageReport, ref: req.query.ref })); }
    catch (e) { return reply.code(500).send(fail(e)); }
  });
  // Instant reopen: last persisted snapshot for a target (no clone/scan); 404 if none.
  app.get<{ Querystring: { path?: string; showDocs?: string } }>('/api/cached', async (req, reply) => {
    const p = req.query.path;
    if (!p) return reply.code(400).send({ error: 'path required' });
    const id = isGitUrl(p) ? parseGitUrl(p).id : localRepoId(p);
    // Only the default docs-visible snapshot is persisted. A docs-hidden request must scan
    // rather than briefly displaying an incompatible cached map.
    if (req.query.showDocs === 'false') return reply.code(404).send({ error: 'no compatible cache' });
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
  app.post<{ Body: { root?: string; on?: boolean; showDocs?: boolean } }>('/api/watch', async (req, reply) => {
    const root = path.resolve(req.body?.root ?? '');
    const t = targets.get(root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    if (t.target.remote) return reply.code(400).send({ error: 'watch mode is for local repos only' });
    if (req.body?.showDocs != null) t.req = { ...t.req, showDocs: req.body.showDocs };
    const existing = watchers.get(root);
    const stop = async (state: WatchState) => {
      state.stopped = true;
      if (state.scanTimer) clearTimeout(state.scanTimer);
      if (state.restartTimer) clearTimeout(state.restartTimer);
      await state.watcher?.close();
    };
    if (!req.body?.on) { if (existing) await stop(existing); watchers.delete(root); return { watching: false }; }
    if (existing) {
      try { await existing.ready; return { watching: true }; }
      catch (e) {
        if (watchers.get(root) === existing) watchers.delete(root);
        await stop(existing);
        return reply.code(500).send(fail(e));
      }
    }
    // Work tree (minus ignored paths and .git internals), plus the bits of .git that change the uncommitted set
    // without touching files: HEAD (checkout), index (add / commit) and refs (commit / reset).
    const gitDir = await new Promise<string>((res) => execFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: root }, (e, out) => res(e ? path.join(root, '.git') : out.trim())));
    const gitPaths = existsSync(gitDir) ? ['HEAD', 'index', 'refs', 'packed-refs'].map((f) => path.join(gitDir, f)) : [];
    const state: WatchState = { ready: Promise.resolve(), stopped: false };
    const rescan = async () => {
      if (state.stopped || watchers.get(root) !== state) return;
      const latest = targets.get(root);
      if (!latest) return;
      try { const s = await doScan(latest.req); send({ type: 'snapshot', root: latest.input, snapshot: transport(s) }); }
      catch (e) { log(`watch rescan failed: ${fail(e).error}`); throw e; }
    };
    const start = async (): Promise<void> => {
      const ignored = await ignoreFilter(root);
      if (state.stopped) return;
      const w = chokidarWatch([root, ...gitPaths], {
        // Ignore files themselves must remain observable so changed rules can rebuild the watcher.
        ignored: (p: string) => {
          if (p === gitDir || p.startsWith(gitDir + path.sep)) return !gitPaths.some((g) => p === g || p.startsWith(g + path.sep)) && p !== gitDir;
          if (['.gitignore', '.gitattributes'].includes(path.basename(p))) return false;
          return ignored(p);
        },
        ignoreInitial: true, awaitWriteFinish: false,
      });
      state.watcher = w;
      let settled = false;
      const ready = new Promise<void>((resolve, reject) => {
        w.once('ready', async () => {
          try {
            // Reconcile after Chokidar's initial crawl. Files created while ignoreInitial was
            // suppressing startup events are therefore still included in the pushed snapshot.
            await rescan();
            settled = true;
            resolve();
          } catch (e) { settled = true; reject(e); }
        });
        w.on('error', (e) => {
          log(`watch error: ${fail(e).error}`);
          if (!settled) { settled = true; reject(e); }
        });
      });
      state.ready = ready;
      w.on('all', (_event, changedPath) => {
        if (state.stopped || state.watcher !== w) return;
        const configChanged = ['.gitignore', '.gitattributes'].includes(path.basename(changedPath));
        if (configChanged) {
          if (state.scanTimer) { clearTimeout(state.scanTimer); state.scanTimer = undefined; }
          if (state.restartTimer) clearTimeout(state.restartTimer);
          state.restartTimer = setTimeout(async () => {
            state.restartTimer = undefined;
            if (state.stopped || state.watcher !== w) return;
            await w.close();
            try { await start(); }
            catch (e) {
              log(`watch restart failed: ${fail(e).error}`);
              if (watchers.get(root) === state) watchers.delete(root);
              await stop(state);
            }
          }, 500);
          return;
        }
        if (state.scanTimer) clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(async () => {
          state.scanTimer = undefined;
          try { await rescan(); } catch { /* rescan logs the actionable error */ }
        }, 500);
      });
      await ready;
    };
    watchers.set(root, state);
    try {
      state.ready = start();
      await state.ready;
      return { watching: true };
    } catch (e) {
      if (watchers.get(root) === state) watchers.delete(root);
      await stop(state);
      return reply.code(500).send(fail(e));
    }
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
  // Changes panel: commit list + diff for a scanned root (refs validated, git run via execFile without a shell).
  const diffCache = new WeakMap<Snapshot, Map<string, Promise<DiffResult>>>();
  const scanned = (root?: string) => { const abs = path.resolve(root ?? ''); const s = root ? snaps.get(abs) : undefined; return s ? { abs, s } : null; };
  const refOk = (r?: string): r is string => typeof r === 'string' && (r === EMPTY_TREE || refShapeOk(r));
  app.get<{ Querystring: { root?: string } }>('/api/git/branches', async (req, reply) => {
    const t = scanned(req.query.root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    return gitBranches(t.abs, t.s.source.type === 'remote');
  });
  app.get<{ Querystring: { root?: string } }>('/api/git/remotes', async (req, reply) => {
    const t = scanned(req.query.root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    const remotes = t.s.git?.available ? await listRemotes(t.abs) : [];
    return { remotes: remotes.map((r) => r.name), local: t.s.source.type !== 'remote' };
  });
  // Fetch only (local repos): updates remote-tracking refs, never the work tree / index / local branches / HEAD.
  const fetching = new Map<string, Promise<unknown>>();
  app.post<{ Querystring: { root?: string } }>('/api/git/fetch', async (req, reply) => {
    const t = scanned(req.query.root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    if (t.s.source.type === 'remote') return reply.code(400).send({ error: 'cloned remotes are fetched by Rescan' });
    if (!t.s.git?.available) return reply.code(400).send({ error: 'not a git repo' });
    const root = t.s.source.path;
    let p = fetching.get(t.abs);
    if (!p) {
      p = fetchRemotes(t.abs, { timeoutMs: 120_000, onProgress: (message, pct) => send({ stage: 'fetch', done: Math.round(pct * 100), total: 100, root, message }) })
        .finally(() => { fetching.delete(t.abs); diffCache.delete(t.s); });
      fetching.set(t.abs, p);
    }
    try { const r = await p; log(`fetch ${t.abs}`); return r; } catch (e) { return reply.code(500).send(fail(e)); }
  });
  app.get<{ Querystring: { root?: string; branch?: string; offset?: string; limit?: string } }>('/api/commits', async (req, reply) => {
    const t = scanned(req.query.root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    if (!t.s.git?.available) return { git: false, commits: [] };
    const branch = req.query.branch || 'HEAD';
    if (!refOk(branch)) return reply.code(400).send({ error: 'invalid branch' });
    if (branch === 'HEAD' && !t.s.git?.head) return { git: true, commits: [] };
    try { return { git: true, commits: await listCommits(t.abs, branch, Number(req.query.offset) || 0, Number(req.query.limit) || 100) }; }
    catch (e) { return reply.code(400).send(fail(e)); }
  });
  app.get<{ Querystring: { root?: string; from?: string; to?: string } }>('/api/diff', async (req, reply) => {
    const t = scanned(req.query.root);
    if (!t) return reply.code(404).send({ error: 'scan first' });
    const { from, to } = req.query;
    if (!refOk(from) || !refOk(to)) return reply.code(400).send({ error: 'invalid from/to' });
    let m = diffCache.get(t.s);
    if (!m) diffCache.set(t.s, (m = new Map()));
    const key = `${t.abs}|${from}|${to}`;
    let p = m.get(key);
    if (!p) { p = diffRange(t.abs, from, to, (rel) => findFile(t.s.root, rel)); m.set(key, p); p.catch(() => m!.delete(key)); }
    try { return await p; } catch (e) { return reply.code(400).send(fail(e)); }
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
  app.addHook('onClose', async () => {
    await Promise.all([...watchers.values()].map(async (state) => {
      state.stopped = true;
      if (state.scanTimer) clearTimeout(state.scanTimer);
      if (state.restartTimer) clearTimeout(state.restartTimer);
      await state.watcher?.close();
    }));
  });

  const address = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  return { app, address, close: () => app.close() };
}
