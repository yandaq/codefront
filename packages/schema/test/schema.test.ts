import { describe, it, expect } from 'vitest';
import { contributors, hostLineUrl } from '../src/index';

describe('contributors', () => {
  const git = { commits: [10, 20, 30, 40], authors: ['ann', 'bob', 'cy'], commitAuthors: [0, 1, 0, 2] };
  it('aggregates by author, most commits first', () => {
    const r = contributors({ last: 40, c: [0, 1, 2, 3], l: [5, 50, 1, 2] }, git);
    expect(r.map((c) => c.name)).toEqual(['ann', 'bob', 'cy']);
    expect(r[0]).toEqual({ name: 'ann', commits: 2, lines: 6, last: 30 });
  });
  it('limits to top N and ignores nodes without data', () => {
    expect(contributors({ last: 40, c: [0, 1, 3], l: [1, 1, 1] }, git, 1)).toHaveLength(1);
    expect(contributors(undefined, git)).toEqual([]);
    expect(contributors({ last: 1, c: [0], l: [1] }, { commits: [1] })).toEqual([]);
  });
});

describe('hostLineUrl', () => {
  it('github', () => {
    expect(hostLineUrl('https://github.com/o/r', 'main', 'src/a b.ts', 12)).toBe('https://github.com/o/r/blob/main/src/a%20b.ts#L12');
    expect(hostLineUrl('git@github.com:o/r.git', 'abc123', 'x.ts', 3, 9)).toBe('https://github.com/o/r/blob/abc123/x.ts#L3-L9');
  });
  it('gitlab', () => {
    expect(hostLineUrl('https://gitlab.com/g/sub/r/', 'dev', 'x.py', 5, 7)).toBe('https://gitlab.com/g/sub/r/-/blob/dev/x.py#L5-7');
    expect(hostLineUrl('https://code.example.com/g/r', 'main', 'x.py')).toBeNull();
    expect(hostLineUrl('https://gitlab.acme.io/g/r.git', 'main', 'x.py')).toBe('https://gitlab.acme.io/g/r/-/blob/main/x.py');
  });
  it('unknown host / bad url', () => {
    expect(hostLineUrl('https://bitbucket.org/o/r', 'main', 'x')).toBeNull();
    expect(hostLineUrl('not a url', 'main', 'x')).toBeNull();
  });
});
