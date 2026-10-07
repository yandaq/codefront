import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeFilePath } from '../src/safe';

const root = mkdtempSync(path.join(tmpdir(), 'codefront-safe-'));
mkdirSync(path.join(root, 'src'));
writeFileSync(path.join(root, 'src/a.ts'), 'x');
const outside = mkdtempSync(path.join(tmpdir(), 'codefront-out-'));
writeFileSync(path.join(outside, 'secret'), 's');
symlinkSync(path.join(outside, 'secret'), path.join(root, 'src/link'));
const allowed = new Set(['src/a.ts', 'src/link', '../secret']);

describe('safeFilePath', () => {
  it('serves snapshot files', () => expect(safeFilePath(root, 'src/a.ts', allowed)).toBe(path.join(root, 'src/a.ts')));
  it('normalises ./ segments', () => expect(safeFilePath(root, './src/../src/a.ts', allowed)).toBe(path.join(root, 'src/a.ts')));
  it('rejects traversal', () => {
    expect(safeFilePath(root, '../secret', allowed)).toBeNull();
    expect(safeFilePath(root, 'src/../../secret', allowed)).toBeNull();
    expect(safeFilePath(root, '..\\secret', allowed)).toBeNull();
  });
  it('rejects absolute and NUL paths', () => {
    expect(safeFilePath(root, '/etc/passwd', new Set(['/etc/passwd']))).toBeNull();
    expect(safeFilePath(root, 'src/a.ts\0', allowed)).toBeNull();
  });
  it('rejects files not in the snapshot', () => expect(safeFilePath(root, 'package.json', allowed)).toBeNull());
  it('rejects symlinks escaping the root', () => expect(safeFilePath(root, 'src/link', allowed)).toBeNull());
});
