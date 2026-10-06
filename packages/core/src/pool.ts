import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { analyzeFile, type FileAnalysis } from './analyze.js';

/** Location of the compiled worker script (next to this module, or in dist/ when running from src under Vitest). */
export function workerScript(): URL | null {
  for (const rel of ['./parse-worker.js', '../parse-worker.js', '../dist/parse-worker.js']) {
    const u = new URL(rel, import.meta.url);
    if (existsSync(fileURLToPath(u))) return u;
  }
  return null;
}

export const defaultPoolSize = () => Math.max(1, Math.min(os.cpus().length - 1, 8));

interface Job { id: number; rel: string; text: string; resolve: (r: FileAnalysis) => void; reject: (e: Error) => void }

/** worker_threads pool running `analyzeFile` (tree-sitter parse + complexity + detectors). */
export class ParsePool {
  private workers: { w: Worker; job: Job | null }[] = [];
  private queue: Job[] = [];
  private seq = 0;

  constructor(script: URL, size = defaultPoolSize()) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(script);
      const slot = { w, job: null as Job | null };
      w.on('message', (m: { id: number; result?: FileAnalysis; error?: string }) => {
        const j = slot.job; slot.job = null;
        if (j) { if (m.error) j.reject(new Error(m.error)); else j.resolve(m.result!); }
        this.pump();
      });
      w.on('error', (e) => { const j = slot.job; slot.job = null; j?.reject(e); });
      this.workers.push(slot);
    }
  }

  static create(size?: number): ParsePool | null {
    const s = workerScript();
    return s ? new ParsePool(s, size) : null;
  }

  run(rel: string, text: string): Promise<FileAnalysis> {
    return new Promise((resolve, reject) => { this.queue.push({ id: this.seq++, rel, text, resolve, reject }); this.pump(); });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.job || !this.queue.length) continue;
      const j = this.queue.shift()!;
      slot.job = j;
      slot.w.postMessage({ id: j.id, rel: j.rel, text: j.text });
    }
  }

  async close() { await Promise.all(this.workers.map((s) => s.w.terminate())); this.workers = []; }
}

/** Analyse many files, in the pool when given (falling back to sync per-file on worker errors). */
export async function analyzeAll(items: { rel: string; text: string }[], pool: ParsePool | null, onDone?: (n: number) => void): Promise<FileAnalysis[]> {
  let n = 0;
  const one = async (it: { rel: string; text: string }) => {
    const r = pool ? await pool.run(it.rel, it.text).catch(() => analyzeFile(it.rel, it.text)) : await analyzeFile(it.rel, it.text);
    onDone?.(++n);
    return r;
  };
  if (pool) return Promise.all(items.map(one));
  const out: FileAnalysis[] = [];
  for (const it of items) out.push(await one(it));
  return out;
}
