/** Given text and comment char ranges, return per-line flag: true if line has code. */
export function codeLines(text: string, comments: Array<[number, number]>): boolean[] {
  const mask = new Uint8Array(text.length);
  for (const [s, e] of comments) mask.fill(1, s, e);
  const lines: boolean[] = [];
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { lines.push(has); has = false; continue; }
    if (!has && !mask[i] && c !== 32 && c !== 9 && c !== 13) has = true;
  }
  if (text.length === 0 || text.charCodeAt(text.length - 1) !== 10) lines.push(has);
  return lines;
}

const HASH_LANG = /\.(py|rb|sh|bash|zsh|pl|r|ya?ml|toml|ps1|mk)$|(^|\/)(Makefile|Dockerfile)$/i;
const C_LANG = /\.(c|h|cc|cpp|hpp|cs|java|go|rs|kt|swift|scala|php|dart|css|scss|less|groovy)$|\.(m?[jt]sx?|cjs)$/i;

/** scc-style fallback: strip //, #, /* *\/ comments by a simple scan (ignores strings). */
export function fallbackComments(text: string, file: string): Array<[number, number]> {
  const hash = HASH_LANG.test(file);
  const cStyle = C_LANG.test(file);
  const out: Array<[number, number]> = [];
  if (!hash && !cStyle) return out;
  let i = 0;
  while (i < text.length) {
    if (cStyle && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const e = end < 0 ? text.length : end + 2;
      out.push([i, e]); i = e;
    } else if ((cStyle && text.startsWith('//', i)) || (hash && text[i] === '#')) {
      let e = text.indexOf('\n', i); if (e < 0) e = text.length;
      out.push([i, e]); i = e;
    } else i++;
  }
  return out;
}

export function countSloc(text: string, comments: Array<[number, number]>): number {
  return codeLines(text, comments).filter(Boolean).length;
}
