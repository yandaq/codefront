/**
 * Small subsequence fuzzy scorer (fzf-ish). Returns null when `q` is not a subsequence of `s`.
 * Rewards consecutive runs, word/path-boundary matches and matches in the basename; penalises gaps and length.
 */
export function fuzzyScore(q: string, s: string): { score: number; idx: number[] } | null {
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  const base = Math.max(s.lastIndexOf('/'), s.lastIndexOf('›')) + 1;
  // greedy-from-the-right start so we prefer matches inside the basename, then forward scan
  let start = sl.lastIndexOf(ql[0]!);
  const tryFrom = (from: number) => {
    const idx: number[] = [];
    let j = from;
    for (const ch of ql) { const k = sl.indexOf(ch, j); if (k < 0) return null; idx.push(k); j = k + 1; }
    return idx;
  };
  let idx = start >= base ? tryFrom(start) : null;
  if (!idx) idx = tryFrom(base) ?? tryFrom(0);
  if (!idx) return null;
  let score = 0, prev = -2;
  for (const k of idx) {
    const c = s[k - 1];
    if (k === prev + 1) score += 8;
    if (k === 0 || c === '/' || c === '_' || c === '-' || c === '.' || c === ' ' || c === '›' || (c && c === c.toLowerCase() && s[k] !== s[k]!.toLowerCase())) score += 6;
    if (k >= base) score += 3;
    if (prev >= 0 && k > prev + 1) score -= Math.min(5, k - prev - 1) * 0.5;
    score += 1; prev = k;
  }
  if (sl.slice(base) === ql) score += 30; // exact basename
  else if (sl.slice(base).startsWith(ql)) score += 12;
  score -= s.length * 0.02;
  start = idx[0]!;
  return { score, idx };
}

export function fuzzySearch<T>(q: string, items: T[], key: (t: T) => string, limit = 50): { item: T; score: number; idx: number[] }[] {
  const out: { item: T; score: number; idx: number[] }[] = [];
  for (const it of items) { const r = fuzzyScore(q, key(it)); if (r) out.push({ item: it, ...r }); }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
