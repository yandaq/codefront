import { describe, it, expect } from 'vitest';
import type { Snapshot, TreeNode } from '@grim-repo/schema';
import { mergeWsSnapshot } from '../src/snapshot';

const file = (detail: boolean): TreeNode => ({ id: 'a.ts', kind: 'file', name: 'a.ts', path: 'a.ts', sloc: 3,
  ...(detail ? { children: [{ id: 'a.ts#f', kind: 'function', name: 'f', path: 'a.ts', sloc: 3 } as TreeNode] } : {}) } as TreeNode);
const snap = (detail: boolean, p = '/r', misses = 1): Snapshot => ({ version: 1, createdAt: '', source: { type: 'local', path: p },
  root: { id: '', kind: 'folder', name: 'r', path: '', sloc: 3, children: [file(detail)] } as TreeNode,
  stats: { files: 1, sloc: 3, parsedFiles: 1, durationMs: 1, cacheHits: 0, cacheMisses: misses } } as Snapshot);

describe('mergeWsSnapshot', () => {
  it('keeps a detailed snapshot over a childless partial, even when it came from a cold scan', () => {
    const full = snap(true, '/r', 1);
    expect(mergeWsSnapshot(full, snap(false), true, true)).toBe(full);
  });
  it('shows a partial while loading when nothing detailed is held', () => {
    const part = snap(false);
    expect(mergeWsSnapshot(null, part, true, true)).toBe(part);
    expect(mergeWsSnapshot(snap(true, '/other'), part, true, true)).toBe(part);
  });
  it('ignores partials once the scan has finished', () => {
    const full = snap(true);
    expect(mergeWsSnapshot(full, snap(false), true, false)).toBe(full);
    expect(mergeWsSnapshot(null, snap(false), true, false)).toBeNull();
  });
  it('always applies full (watch/refresh) snapshots', () => {
    const next = snap(true);
    expect(mergeWsSnapshot(snap(true), next, false, false)).toBe(next);
  });
});
