import { hostLineUrl, type Snapshot } from '@grim-repo/schema';

export type Editor = 'vscode' | 'cursor' | 'jetbrains' | 'none';
const KEY = 'grim-repo.editor';
export function loadEditor(): Editor {
  try { const v = localStorage.getItem(KEY); if (v === 'vscode' || v === 'cursor' || v === 'jetbrains' || v === 'none') return v; } catch { /* storage blocked */ }
  return 'vscode';
}
export function saveEditor(e: Editor) { try { localStorage.setItem(KEY, e); } catch { /* storage blocked */ } }

/** Link for "open" — host line URL when the snapshot came from a remote (M6), else a local editor URL. */
export function openUrl(snap: Snapshot, rel: string, line = 1, editor: Editor = loadEditor()): string | null {
  const { webUrl, ref } = snap.source;
  if (webUrl) return hostLineUrl(webUrl, ref ?? snap.git?.head ?? 'HEAD', rel, line);
  const abs = `${snap.source.path.replace(/\/+$/, '')}/${rel}`;
  switch (editor) {
    case 'vscode': return `vscode://file${encodeURI(abs.startsWith('/') ? abs : '/' + abs)}:${line}`;
    case 'cursor': return `cursor://file${encodeURI(abs.startsWith('/') ? abs : '/' + abs)}:${line}`;
    case 'jetbrains': return `idea://open?file=${encodeURIComponent(abs)}&line=${line}`;
    default: return null;
  }
}
