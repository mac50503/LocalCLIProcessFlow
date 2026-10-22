import { z } from "zod";

const nodeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "node id must start with a letter and use letters, digits, _ or -");
const nodeTypeSchema = z.string().regex(/^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/, "node type must look like \"category.name\"");

export const limitsSchema = z.strictObject({
  nodeTimeoutMs: z.number().int().positive().optional(),
  workflowTimeoutMs: z.number().int().positive().optional(),
  maxPayloadBytes: z.number().int().positive().optional()
});

export const workflowNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: nodeTypeSchema,
  name: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({})
});

export const workflowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "workflow id must be kebab-case"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  requires: z
    .strictObject({
      nodes: z.record(z.string(), z.number().int().positive()).optional(),
      providers: z.array(z.string()).optional()
    })
    .optional(),
  limits: limitsSchema.optional(),
  nodes: z.array(workflowNodeSchema).min(1).max(100)
});

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowLimits = z.infer<typeof limitsSchema>;
