import path from 'node:path';
import type { Snapshot } from '@grim-repo/schema';
import { scan, type ScanOptions } from './index.js';
import { RepoCache, localRepoId } from './cache.js';
import { isGitUrl, parseGitUrl, ensureClone, backfill, listBranches, currentBranch, checkoutBranch, matchBranch, type RemoteInfo } from './remote.js';

export interface ResolvedTarget { root: string; id: string; remote?: RemoteInfo; branch?: string; branches?: string[] }

export interface TargetOptions {
  ref?: string;
  /** Remote: `git fetch` + reset to origin/<branch> first. */
  fetch?: boolean;
  onProgress?: ScanOptions['onProgress'];
}

/** Resolve a local path or git URL to a work tree (cloning / switching branch as needed). */
export async function resolveTarget(input: string, opts: TargetOptions = {}): Promise<ResolvedTarget> {
  if (!isGitUrl(input)) { const root = path.resolve(input); return { root, id: localRepoId(root) }; }
  const remote = parseGitUrl(input);
  opts.onProgress?.({ stage: 'clone', done: 0, total: 100, message: `Cloning ${remote.cloneUrl}` });
  const { dir, cloned } = await ensureClone(remote, { onProgress: (msg, pct) => opts.onProgress?.({ stage: 'clone', done: Math.round(pct * 100), total: 100, message: msg }) });
  const branches = await listBranches(dir);
  const want = opts.ref ? (branches.includes(opts.ref) ? opts.ref : matchBranch(opts.ref, branches)) : remote.ref ? matchBranch(remote.ref, branches) : null;
  const cur = await currentBranch(dir);
  const branch = want ?? cur ?? branches[0];
  if (branch && (branch !== cur || (opts.fetch && !cloned))) {
    opts.onProgress?.({ stage: 'clone', done: 50, total: 100, message: opts.fetch ? `Fetching ${branch}` : `Checking out ${branch}` });
    await checkoutBranch(dir, remote, branch, !!opts.fetch && !cloned);
  }
  if (cloned || opts.fetch) {
    opts.onProgress?.({ stage: 'clone', done: 90, total: 100, message: 'Fetching history blobs' });
    await backfill(dir, remote);
  }
  opts.onProgress?.({ stage: 'clone', done: 100, total: 100 });
  return { root: dir, id: remote.id, remote, branch, branches: opts.fetch && !cloned ? await listBranches(dir) : branches };
}

export function decorateSource(snap: Snapshot, t: ResolvedTarget): Snapshot {
  if (t.remote) snap.source = { type: 'remote', path: t.root, url: t.remote.cloneUrl, webUrl: t.remote.webUrl, ref: t.branch };
  return snap;
}

/** Cached snapshot for a target, without scanning (instant reopen). */
export async function cachedSnapshot(t: ResolvedTarget): Promise<Snapshot | null> {
  return (await RepoCache.open(t.id)).loadSnapshot();
}

/** Full pipeline: resolve (clone/fetch), incremental scan with the on-disk cache, persist. */
export async function scanTarget(input: string, opts: TargetOptions & ScanOptions & { useCache?: boolean } = {}): Promise<{ snapshot: Snapshot; target: ResolvedTarget; cache?: RepoCache }> {
  const target = await resolveTarget(input, opts);
  const cache = opts.useCache === false ? undefined : await RepoCache.open(target.id);
  const snapshot = decorateSource(await scan(target.root, { ...opts, cache, onPartial: opts.onPartial && ((s) => opts.onPartial!(decorateSource(s, target))) }), target);
  // persist only default-option snapshots as the "reopen" snapshot
  await cache?.save(!opts.showDocs && !opts.coverageReport ? snapshot : undefined);
  return { snapshot, target, cache };
}
