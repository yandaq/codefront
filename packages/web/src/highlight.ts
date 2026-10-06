import type { HighlighterCore, ThemedToken, ThemeRegistrationRaw } from 'shiki/core';

/** Mission Control dark theme for Shiki. */
const THEME: ThemeRegistrationRaw = {
  name: 'mission-control', type: 'dark',
  settings: [
    { settings: { foreground: '#cbd5e1', background: '#0a0e17' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#475569', fontStyle: 'italic' } },
    { scope: ['string', 'string.template', 'punctuation.definition.string'], settings: { foreground: '#5eead4' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#fbbf24' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: '#c084fc' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: '#64748b' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: '#22d3ee' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.other.inherited-class'], settings: { foreground: '#7dd3fc' } },
    { scope: ['variable.parameter'], settings: { foreground: '#fda4af' } },
    { scope: ['variable.other.property', 'meta.object-literal.key', 'support.variable.property'], settings: { foreground: '#a5b4fc' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#38bdf8' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#a5b4fc' } },
  ],
};

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
};

let hl: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
async function get(): Promise<HighlighterCore> {
  hl ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return hl;
}

export function langOf(path: string, language?: string): string | null {
  if (language && LANGS[language]) return language;
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'tsx', py: 'python' } as Record<string, string>)[ext ?? ''] ?? null;
}

/** Tokenise source; falls back to plain lines for unsupported languages. */
export async function tokenize(code: string, lang: string | null): Promise<ThemedToken[][]> {
  if (!lang || !LANGS[lang]) return code.split('\n').map((l) => [{ content: l, offset: 0, color: '#cbd5e1' }]);
  const h = await get();
  if (!loaded.has(lang)) { const mod = (await LANGS[lang]!()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }; await h.loadLanguage(mod.default); loaded.add(lang); }
  return h.codeToTokensBase(code, { lang, theme: 'mission-control' });
}
