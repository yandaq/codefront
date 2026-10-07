import type { Snapshot, TreeNode } from '@codefront/schema';

const hasDetail = (n: TreeNode): boolean => (n.kind === 'file' ? !!n.children?.length : !!n.children?.some(hasDetail));

/**
 * Snapshot pushed over the progress socket. A `partial` (progressive, unparsed files have no
 * functions) is only a placeholder while a scan is in flight: it must never replace a snapshot of
 * the same source that already carries sub-file structure, or the treemap loses its functions.
 */
export function mergeWsSnapshot(prev: Snapshot | null, next: Snapshot, partial: boolean, loading: boolean): Snapshot | null {
  if (!partial) return next;
  if (!loading) return prev;
  if (prev && prev.source.path === next.source.path && hasDetail(prev.root)) return prev;
  return next;
}
