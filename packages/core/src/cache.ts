import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Snapshot, TreeNode } from '@codefront/schema';
import { ANALYSIS_VERSION, type FileAnalysis } from './analyze.js';
import type { RawHistory, BlameCache } from './git.js';

/** Root for clones and caches (`~/.codefront`; override with CODEFRONT_HOME, e.g. in tests). */
export const codefrontHome = () => process.env.CODEFRONT_HOME ?? path.join(os.homedir(), '.codefront');
export const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');
export const contentHash = (text: string) => `c:${sha1(text)}`;
/** Repo id for a local path. */
export const localRepoId = (abs: string) => `local-${sha1(path.resolve(abs)).slice(0, 16)}`;

async function readJson<T>(f: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(f, 'utf8')) as T; } catch { return null; }
}
async function writeJson(f: string, v: unknown) {
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(v));
  await fs.rename(tmp, f);
}

/**
 * On-disk cache in `~/.codefront/cache/<repo-id>/`: last snapshot, per-file analysis keyed by path + blob SHA,
 * raw git history (for incremental refresh), and blame ages keyed by path + blob + HEAD.
 */
export class RepoCache {
  files = new Map<string, FileAnalysis>();
  blame = new Map<string, Record<string, number>>();
  history: RawHistory | null = null;
  private used = new Set<string>();
  private blameUsed = new Set<string>();
  hits = 0; misses = 0;

  private constructor(readonly dir: string) {}

  static async open(id: string): Promise<RepoCache> {
    const c = new RepoCache(path.join(codefrontHome(), 'cache', id));
    await fs.mkdir(c.dir, { recursive: true });
    const files = await readJson<{ v: number; files: Record<string, FileAnalysis> }>(path.join(c.dir, 'files.json'));
    if (files?.v === ANALYSIS_VERSION) c.files = new Map(Object.entries(files.files));
    const blame = await readJson<Record<string, Record<string, number>>>(path.join(c.dir, 'blame.json'));
    if (blame) c.blame = new Map(Object.entries(blame));
    c.history = await readJson<RawHistory>(path.join(c.dir, 'history.json'));
    return c;
  }

  static key(rel: string, hash: string) { return `${rel}\0${hash}`; }

  /** A deep copy (scan mutates nodes), or undefined on miss. */
  getFile(rel: string, hash: string): FileAnalysis | undefined {
    const k = RepoCache.key(rel, hash);
    const v = this.files.get(k);
    if (v) { this.hits++; this.used.add(k); return structuredClone(v); }
    this.misses++;
    return undefined;
  }
  setFile(rel: string, hash: string, v: FileAnalysis) { const k = RepoCache.key(rel, hash); this.files.set(k, structuredClone(v)); this.used.add(k); }

  blameCache(head: string | undefined): BlameCache {
    const k = (f: TreeNode) => `${f.path}\0${f.hash ?? ''}\0${head ?? ''}`;
    return {
      get: (f) => { if (!f.hash || !head) return undefined; const v = this.blame.get(k(f)); if (v) this.blameUsed.add(k(f)); return v; },
      set: (f, v) => { if (!f.hash || !head) return; this.blame.set(k(f), v); this.blameUsed.add(k(f)); },
    };
  }

  async loadSnapshot(): Promise<Snapshot | null> { return readJson<Snapshot>(path.join(this.dir, 'snapshot.json')); }

  /** Persist; per-file entries not used by the latest scan are dropped. */
  async save(snapshot?: Snapshot) {
    const files: Record<string, FileAnalysis> = {};
    for (const k of this.used) { const v = this.files.get(k); if (v) files[k] = v; }
    await writeJson(path.join(this.dir, 'files.json'), { v: ANALYSIS_VERSION, files });
    if (this.history) await writeJson(path.join(this.dir, 'history.json'), this.history);
    if (snapshot) await writeJson(path.join(this.dir, 'snapshot.json'), snapshot);
  }

  async saveBlame() {
    const out: Record<string, Record<string, number>> = {};
    for (const [k, v] of this.blame) if (this.blameUsed.has(k)) out[k] = v;
    await writeJson(path.join(this.dir, 'blame.json'), out);
  }
}
