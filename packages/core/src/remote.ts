import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { grimHome, sha1 } from './cache.js';

const exec = promisify(execFile);

export interface RemoteInfo {
  /** URL passed to `git clone`. */
  cloneUrl: string;
  /** Browser URL of the repo (no trailing .git), when derivable. */
  webUrl?: string;
  host: string;
  /** Normalised `host/owner/repo` (lower-case, no .git) — the identity hashed into the id. */
  key: string;
  id: string;
  /** Branch (possibly with a trailing sub-path) from `/tree/<branch>` style web URLs. */
  ref?: string;
}

export function isGitUrl(s: string): boolean {
  return /^(https?|ssh|git):\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

/** Normalise any git URL (https, ssh, scp-like, GitHub/GitLab/Bitbucket web URLs incl. /tree/<branch>). */
export function parseGitUrl(input: string): RemoteInfo {
  let s = input.trim();
  let host: string, repoPath: string, scheme: 'https' | 'ssh' | 'http' | 'git';
  let user = '';
  const scp = s.match(/^([\w.-]+)@([\w.-]+):(?!\/\/)(.*)$/);
  if (scp) { user = scp[1]!; host = scp[2]!; repoPath = scp[3]!; scheme = 'ssh'; }
  else {
    const u = new URL(s);
    scheme = u.protocol.replace(':', '') as typeof scheme;
    host = u.hostname + (u.port ? `:${u.port}` : '');
    user = u.username;
    repoPath = decodeURIComponent(u.pathname);
  }
  repoPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '');
  let ref: string | undefined;
  // web URL forms: GitHub /tree|blob/<ref>, GitLab /-/tree/<ref>, Bitbucket /src/<ref>
  const segs = repoPath.split('/');
  const markers = ['-', 'tree', 'blob', 'src', 'commits', 'branches'];
  let cut = segs.findIndex((x, i) => i >= 2 && markers.includes(x));
  if (cut >= 0) {
    let rest = segs.slice(cut + 1);
    if (segs[cut] === '-') rest = rest.slice(1); // GitLab "/-/tree/<ref>"
    if (['tree', 'blob', 'src'].includes(segs[cut] === '-' ? segs[cut + 1] ?? '' : segs[cut]!) && rest.length) ref = rest.join('/');
    repoPath = segs.slice(0, cut).join('/');
  }
  repoPath = repoPath.replace(/\.git$/, '');
  const lowerHost = host.toLowerCase();
  const key = `${lowerHost}/${repoPath.toLowerCase()}`;
  const webUrl = `https://${lowerHost.replace(/:\d+$/, '')}/${repoPath}`;
  const cloneUrl = scheme === 'ssh'
    ? (scp ? `${user || 'git'}@${host}:${repoPath}.git` : `ssh://${user ? user + '@' : ''}${host}/${repoPath}.git`)
    : `${scheme}://${host}/${repoPath}${scheme === 'git' ? '' : '.git'}`;
  return { cloneUrl, webUrl, host: lowerHost, key, id: `remote-${sha1(key).slice(0, 16)}`, ref };
}

/** Parse `git branch -r` output into branch names (origin/ stripped, HEAD pointer dropped). */
export function parseBranches(out: string): string[] {
  return [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('->') && l !== 'origin' && !/^origin\/HEAD$/.test(l))
    .map((l) => l.replace(/^origin\//, '')))].sort();
}

/** Resolve a `/tree/<ref...>` capture (which may include a sub-path) to the longest matching branch. */
export function matchBranch(ref: string, branches: string[]): string | null {
  const segs = ref.split('/');
  for (let i = segs.length; i > 0; i--) { const b = segs.slice(0, i).join('/'); if (branches.includes(b)) return b; }
  return null;
}

// ---------------- auth ----------------

let keytarP: Promise<any | null> | null = null;
/** keytar is optional (native); null when it can't load. */
export function loadKeytar(): Promise<any | null> {
  keytarP ??= import('keytar' as string).then((m) => m.default ?? m).catch(() => null);
  return keytarP;
}
const KEYCHAIN_SERVICE = 'grim-repo';
export async function savePat(host: string, token: string): Promise<boolean> {
  const k = await loadKeytar(); if (!k) return false;
  await k.setPassword(KEYCHAIN_SERVICE, host, token); return true;
}
export async function deletePat(host: string) { const k = await loadKeytar(); if (k) await k.deletePassword(KEYCHAIN_SERVICE, host); }
async function getPat(host: string): Promise<string | null> {
  const k = await loadKeytar(); if (!k) return null;
  try { return await k.getPassword(KEYCHAIN_SERVICE, host); } catch { return null; }
}
async function ghToken(): Promise<string | null> {
  try { const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 5000 }); return stdout.trim() || null; } catch { return null; }
}

/**
 * Environment for git commands against a remote. Never executes repo code (hooks disabled, LFS smudge off),
 * never prompts. For https: a `gh auth token` (github.com) or keychain PAT is injected as an in-memory
 * `http.extraHeader` via GIT_CONFIG_* env vars — never written to disk, argv or logs.
 */
export async function gitEnv(info: Pick<RemoteInfo, 'cloneUrl' | 'host'>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GCM_INTERACTIVE: 'never' };
  const cfg: [string, string][] = [['core.hooksPath', '/dev/null'], ['protocol.file.allow', 'never']];
  if (/^https:/.test(info.cloneUrl)) {
    const token = (info.host === 'github.com' ? await ghToken() : null) ?? (await getPat(info.host));
    if (token) {
      const user = info.host.includes('gitlab') ? 'oauth2' : info.host.includes('bitbucket') ? 'x-token-auth' : 'x-access-token';
      cfg.push([`http.https://${info.host}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`]);
    }
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

// ---------------- clone / fetch / branches ----------------

export const repoDir = (info: Pick<RemoteInfo, 'id'>) => path.join(grimHome(), 'repos', info.id);

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine?: (l: string) => void, timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d: Buffer) => {
      const t = d.toString(); err += t;
      if (err.length > 20000) err = err.slice(-10000);
      if (onLine) for (const l of t.split(/[\r\n]+/)) if (l.trim()) onLine(l.trim());
    });
    p.on('error', reject);
    p.on('close', (code, sig) => (sig && timeout ? reject(new Error(`git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`)) : code === 0 ? resolve(out) : reject(new Error(cleanGitError(err) || `git ${args[0]} failed (${code})`))));
  });
}
const cleanGitError = (e: string) => e.split('\n').filter((l) => /fatal|error|denied|not found|could not/i.test(l)).join('\n').replace(/Authorization: Basic \S+/g, 'Authorization: ***').trim();

/** Parse a git progress line ("Receiving objects:  45% (9/20)") into a fraction. */
export function gitProgress(line: string): { phase: string; pct: number } | null {
  const m = line.match(/^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/);
  return m ? { phase: m[1]!.trim(), pct: Number(m[2]) / 100 } : null;
}

export interface CloneOptions { onProgress?: (msg: string, pct: number) => void }

/** Clone (blobless) into ~/.grim-repo/repos/<id>, or reuse an existing clone. Returns the work tree path. */
export async function ensureClone(info: RemoteInfo, opts: CloneOptions = {}): Promise<{ dir: string; cloned: boolean }> {
  const dir = repoDir(info);
  if (existsSync(path.join(dir, '.git'))) return { dir, cloned: false };
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.rm(dir, { recursive: true, force: true });
  const env = await gitEnv(info);
  const phases = ['Counting objects', 'Compressing objects', 'Receiving objects', 'Resolving deltas', 'Updating files'];
  await runGit(['clone', '--filter=blob:none', '--no-tags', '--progress', '--', info.cloneUrl, dir], path.dirname(dir), env, (l) => {
    const p = gitProgress(l);
    if (!p) return;
    const ix = Math.max(0, phases.indexOf(p.phase));
    opts.onProgress?.(p.phase, (ix + p.pct) / phases.length);
  });
  return { dir, cloned: true };
}

/**
 * Batch-download historical blobs (git ≥ 2.49 `git backfill`) so `git log --numstat` / blame don't
 * lazily fetch one commit at a time. Best-effort: older git falls back to on-demand fetching.
 */
export async function backfill(dir: string, info: RemoteInfo): Promise<boolean> {
  try { await runGit(['backfill'], dir, await gitEnv(info)); return true; } catch { return false; }
}

export async function listBranches(dir: string): Promise<string[]> {
  const { stdout } = await exec('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: dir });
  return parseBranches(stdout);
}
export async function currentBranch(dir: string): Promise<string | null> {
  try { return (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim(); } catch { return null; }
}

/** Fetch from origin (optionally) and hard-reset the work tree to origin/<branch>. */
export async function checkoutBranch(dir: string, info: RemoteInfo, branch: string, fetch: boolean): Promise<void> {
  const env = await gitEnv(info);
  if (fetch) await runGit(['fetch', '--prune', '--no-tags', 'origin'], dir, env);
  await runGit(['checkout', '-q', '-f', '-B', branch, `origin/${branch}`], dir, env);
  await runGit(['reset', '-q', '--hard', `origin/${branch}`], dir, env);
}

// ---------------- fetch (local repos) ----------------

export interface FetchSummary {
  remotes: { name: string; url: string; ok: boolean; error?: string; authHint?: string }[];
  added: string[]; updated: string[]; pruned: string[];
}

async function remoteRefs(dir: string): Promise<Map<string, string>> {
  const { stdout } = await exec('git', ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes'], { cwd: dir });
  const m = new Map<string, string>();
  for (const l of stdout.split('\n')) { const i = l.indexOf(' '); if (i > 0 && !l.endsWith('/HEAD')) m.set(l.slice(i + 1).replace(/^refs\/remotes\//, ''), l.slice(0, i)); }
  return m;
}

export async function listRemotes(dir: string): Promise<{ name: string; url: string }[]> {
  try {
    const { stdout } = await exec('git', ['remote'], { cwd: dir });
    const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return await Promise.all(names.map(async (name) => ({ name, url: (await exec('git', ['remote', 'get-url', '--', name], { cwd: dir }).catch(() => ({ stdout: '' }))).stdout.trim() })));
  } catch { return []; }
}

/**
 * FETCH ONLY: `git fetch --prune` for every remote (equivalent to `--all --prune`). Updates refs/remotes only —
 * never the work tree, index, local branches or HEAD. Hooks are disabled and prompts off; https remotes get the
 * M6 token injection (gh / keychain PAT), SSH and the user's credential helper work as usual.
 */
export async function fetchRemotes(dir: string, opts: { onProgress?: (msg: string, pct: number) => void; timeoutMs?: number } = {}): Promise<FetchSummary> {
  const remotes = await listRemotes(dir);
  const before = await remoteRefs(dir);
  const res: FetchSummary = { remotes: [], added: [], updated: [], pruned: [] };
  const phases = ['Counting objects', 'Compressing objects', 'Receiving objects', 'Resolving deltas'];
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (const [i, r] of remotes.entries()) {
    let info: Pick<RemoteInfo, 'cloneUrl' | 'host'> = { cloneUrl: r.url, host: '' };
    try { if (isGitUrl(r.url)) { const p = parseGitUrl(r.url); info = { cloneUrl: r.url, host: p.host }; } } catch { /* local path etc. */ }
    const env = await gitEnv(info);
    // gitEnv blocks the file protocol (for untrusted clones); a user's own local-path remote is legitimate here.
    for (let k = 0; k < Number(env.GIT_CONFIG_COUNT); k++) if (env[`GIT_CONFIG_KEY_${k}`] === 'protocol.file.allow') env[`GIT_CONFIG_VALUE_${k}`] = 'always';
    const onLine = (l: string) => {
      const p = gitProgress(l); if (!p) return;
      const ix = Math.max(0, phases.indexOf(p.phase));
      opts.onProgress?.(`${r.name}: ${p.phase}`, (i + (ix + p.pct) / phases.length) / remotes.length);
    };
    opts.onProgress?.(`${r.name}: connecting`, i / remotes.length);
    const args = (fh: boolean) => ['fetch', '--prune', '--progress', ...(fh ? ['--no-write-fetch-head'] : []), '--', r.name];
    const left = Math.max(1000, deadline - Date.now());
    try {
      try { await runGit(args(true), dir, env, onLine, left); }
      catch (e) { if (!/no-write-fetch-head|unknown option/i.test(String((e as Error).message))) throw e; await runGit(args(false), dir, env, onLine, left); }
      res.remotes.push({ ...r, ok: true });
    } catch (e) {
      const msg = String((e as Error).message);
      const auth = /auth|denied|403|401|could not read Username|terminal prompts disabled/i.test(msg);
      res.remotes.push({ ...r, ok: false, error: msg, authHint: auth && info.host ? info.host : undefined });
    }
  }
  const after = await remoteRefs(dir);
  for (const [k, v] of after) { const o = before.get(k); if (o == null) res.added.push(k); else if (o !== v) res.updated.push(k); }
  for (const k of before.keys()) if (!after.has(k)) res.pruned.push(k);
  opts.onProgress?.('done', 1);
  return res;
}
