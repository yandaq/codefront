import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzySearch } from '../src/fuzzy';

describe('fuzzyScore', () => {
  it('requires subsequence', () => {
    expect(fuzzyScore('xyz', 'packages/core/src/git.ts')).toBeNull();
    expect(fuzzyScore('gt', 'packages/core/src/git.ts')).not.toBeNull();
  });
  it('returns match indices', () => expect(fuzzyScore('ab', 'xaxb')!.idx).toEqual([1, 3]));
  it('ranks basename and contiguous matches higher', () => {
    const items = ['packages/git/src/other.ts', 'packages/core/src/git.ts', 'g/i/t.ts'];
    expect(fuzzySearch('git', items, (s) => s)[0]!.item).toBe('packages/core/src/git.ts');
  });
  it('prefers word boundaries / camelCase', () => {
    const r = fuzzySearch('rh', ['core/git.ts › readHistory', 'core/x.ts › rhubarbish'], (s) => s);
    expect(r).toHaveLength(2);
    expect(fuzzySearch('readhist', ['a.ts › readHistory', 'a.ts › reader', 'b.ts › threadhistoric'], (s) => s)[0]!.item).toBe('a.ts › readHistory');
  });
  it('is fast on 50k items', () => {
    const items = Array.from({ length: 50000 }, (_, i) => `src/mod${i % 97}/file${i}.ts › fn${i}`);
    const t = performance.now();
    fuzzySearch('mod5fn', items, (s) => s);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
