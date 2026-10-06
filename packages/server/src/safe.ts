import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Resolve `rel` inside `root`, refusing anything that escapes it (`..`, absolute paths, symlinks out)
 * or that is not one of the snapshot's files. Returns the absolute path or null.
 */
export function safeFilePath(root: string, rel: string, allowed: Set<string>): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('../') || norm === '..' || !allowed.has(norm)) return null;
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, norm);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  try {
    const real = realpathSync(abs), realRoot = realpathSync(absRoot);
    if (!real.startsWith(realRoot + path.sep)) return null;
  } catch { return null; }
  return abs;
}
