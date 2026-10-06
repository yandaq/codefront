import { z } from 'zod';

export const NodeKind = z.enum(['folder', 'file', 'class', 'function', 'module-scope', 'small-group']);
export type NodeKind = z.infer<typeof NodeKind>;

export interface TreeNode {
  id: string;
  name: string;
  kind: NodeKind;
  path: string;
  sloc: number;
  language?: string;
  startLine?: number;
  endLine?: number;
  children?: TreeNode[];
}

export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    kind: NodeKind,
    path: z.string(),
    sloc: z.number().int().nonnegative(),
    language: z.string().optional(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    children: z.array(TreeNodeSchema).optional(),
  }),
);

export const SnapshotSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  source: z.object({ type: z.literal('local'), path: z.string() }),
  stats: z.object({ files: z.number(), sloc: z.number(), parsedFiles: z.number(), durationMs: z.number() }),
  root: TreeNodeSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ScanRequestSchema = z.object({ path: z.string().min(1), showDocs: z.boolean().optional() });
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export interface ScanProgress { stage: 'walk' | 'sloc' | 'parse' | 'done'; done: number; total: number }
