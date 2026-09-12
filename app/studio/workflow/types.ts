import { z } from "zod";
import { draftNodeSchema } from "../submission/types";

const id = z.string().min(1).max(250);
export const layoutDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("component_variant"), nodeId: id, componentId: id, requirementIds: z.array(id).default([]) }).strict(),
  z.object({ kind: z.literal("image_group"), nodeIds: z.array(id).min(1).max(3), requirementIds: z.array(id).default([]) }).strict(),
]);
export const layoutDecisionSetSchema = z.object({
  schema: z.literal("opslion/layout-decisions/v1"), baseRevision: id, id,
  decisions: z.array(layoutDecisionSchema).max(200),
  unresolved: z.array(z.object({ id, message: z.string().min(1) }).strict()).max(100),
}).strict();
export const workflowSchema = z.object({
  schema: z.literal("opslion/workflow/v1"),
  basis: z.array(draftNodeSchema),
  edits: z.array(z.object({ id, origin: z.enum(["human", "rule", "model"]), changed: z.array(id), added: z.array(id), deleted: z.array(id), layoutChanged: z.boolean(), at: z.string() }).strict()).max(200),
  decisions: z.array(z.object({ decision: layoutDecisionSchema, origin: z.enum(["human", "model"]), locked: z.boolean() }).strict()).max(1000),
  // Read older project records without using them as workstation or export requirements.
  reviews: z.array(z.object({ id, round: z.union([z.literal(1), z.literal(2)]), reviewerKind: z.literal("human"), reviewerLabel: z.string(), revision: id, nodes: z.array(draftNodeSchema), layoutRevision: id, at: z.string() }).strict()).max(50).optional(),
  run: z.object({ id, inputRevision: id, mode: z.enum(["local", "ai"]), status: z.enum(["local", "enhanced", "fallback", "cancelled", "stale"]), message: z.string(), visualReview: z.literal("not-run"), requests: z.number().int().nonnegative().nullable(), usage: z.unknown().optional() }).strict().optional(),
}).strict();
export type Workflow = z.infer<typeof workflowSchema>;
export type LayoutDecision = z.infer<typeof layoutDecisionSchema>;
export type LayoutDecisionSet = z.infer<typeof layoutDecisionSetSchema>;
