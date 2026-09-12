import { z } from "zod";
import { articleNodeSchema, parsedArticleSchema, richTextSchema } from "../template-engine/types";
import { safeImageUrl, safeLinkUrl } from "../html-policy";

const id = z.string().min(1).max(250);
const ids = z.array(id);
const link = z.string().refine((value) => Boolean(safeLinkUrl(value)), "图片链接无效");
export const assetSchema = z.object({
  disabled: z.boolean().optional(),
  id, storage_ref: z.string().refine((value) => Boolean(safeImageUrl(value)), "素材资源无效"), media_type: z.string(),
  origins: z.array(z.object({ file_id: id, relative_path: z.string(), document_id: id.optional(), occurrence_id: id.optional(), article_id: id.optional(), node_id: id.optional() })),
  aliases: z.array(z.object({ text: z.string(), document_id: id.optional(), section_source_id: id.optional() })).default([]),
  reusable: z.object({ scope_id: id, key: id }).optional(),
}).strict();
export const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), asset_id: id }).strict(),
  z.object({ kind: z.literal("occurrence"), document_id: id, occurrence_id: id }).strict(),
  z.object({ kind: z.literal("file"), relative_path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("label"), text: z.string().min(1), document_id: id, section_source_id: id.optional() }).strict(),
  z.object({ kind: z.literal("base_node"), article_id: id, node_id: id }).strict(),
  z.object({ kind: z.literal("reusable"), scope_id: id, key: id }).strict(),
  z.object({ kind: z.literal("description"), text: z.string().min(1), source_file_ids: ids.optional() }).strict(),
]);
export const imageRequestSchema = z.object({ id, purpose: z.string().min(1), selector: selectorSchema, source_ids: ids.default([]) }).strict();
export const imageRefSchema = z.object({ id, type: z.literal("image_ref"), request_id: id, caption: richTextSchema.optional(), alt: z.string().optional(), link_url: link.optional(), previous: articleNodeSchema.optional() }).strict();
export const draftNodeSchema = z.union([articleNodeSchema, imageRefSchema]);
const sourceNodeSchema = z.object({
  id, type: z.enum(["article_title", "subtitle", "heading1", "heading2", "heading3", "paragraph", "quote", "ul", "ol", "divider", "image_ref"]),
  source_ids: ids.default([]), content: richTextSchema.optional(), request_id: id.optional(), caption: richTextSchema.optional(), alt: z.string().optional(), link_url: link.optional(),
  start: z.number().int().positive().optional(), items: z.array(z.object({ id, content: richTextSchema, source_ids: ids.default([]) }).strict()).optional(),
}).strict();
export const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_content"), target_node_id: id, content: richTextSchema }).strict(),
  z.object({ op: z.literal("set_image"), target_node_id: id, request_id: id }).strict(),
  z.object({ op: z.literal("set_image_meta"), target_node_id: id, caption: richTextSchema.nullable().optional(), alt: z.string().nullable().optional(), link_url: link.nullable().optional() }).strict(),
  z.object({ op: z.literal("insert_nodes"), anchor_node_id: id, position: z.enum(["before", "after"]), nodes: z.array(sourceNodeSchema).min(1) }).strict(),
  z.object({ op: z.literal("remove_nodes"), target_node_ids: ids.min(1) }).strict(),
  z.object({ op: z.literal("move_nodes"), target_node_ids: ids.min(1), anchor_node_id: id, position: z.enum(["before", "after"]) }).strict(),
]);
export const pendingSchema = z.object({ id, kind: z.enum(["select_target", "conflicting_instruction", "asset_edit_required", "layout_preference", "other"]), message: z.string().min(1), candidate_ids: ids.default([]), source_ids: ids.default([]), proposed_change: changeSchema.optional() }).strict();
export const submissionPlanSchema = z.object({
  schema: z.literal("opslion/submission-plan/v1"), mode: z.enum(["new", "update", "derive"]), base_article_id: id.optional(),
  article: z.object({ nodes: z.array(sourceNodeSchema) }).strict().optional(), changes: z.array(changeSchema).optional(),
  image_requests: z.array(imageRequestSchema), pending: z.array(pendingSchema),
  excluded_sources: z.array(z.object({ source_id: id, role: z.enum(["instruction", "reference"]), reason: z.string().min(1) }).strict()).default([]),
  asset_aliases: z.array(z.object({ asset_id: id, text: z.string().min(1), document_id: id, section_source_id: id.optional() }).strict()).default([]),
  publishing: z.object({ cover_request_id: id.nullable() }).strict().optional(),
  relations: z.array(z.object({ kind: z.enum(["shared_caption", "cross_reference", "sequence"]), node_ids: ids.min(2) }).strict()).default([]),
}).strict();
const blockSchema = z.object({ id, kind: z.enum(["paragraph", "image", "divider"]), content: richTextSchema, clues: z.record(z.string(), z.unknown()), image_anchor_id: id.optional(), caption: richTextSchema.optional() });
export const bindingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("bound"), asset_id: id, chosen_by: z.enum(["exact_match", "user"]) }).strict(),
  z.object({ status: z.literal("pending"), reason: z.string(), candidate_asset_ids: ids }).strict(),
]);
export const submissionSchema = z.object({
  schema: z.literal("opslion/submission/v1"), id, mode: z.enum(["new", "update", "derive"]), user_instructions: z.string(),
  files: z.array(z.object({ id, relative_path: z.string(), media_type: z.string(), role: z.enum(["main", "instructions", "asset", "reference"]), error: z.string().optional(), disabled: z.boolean().optional() })),
  documents: z.array(z.object({ id, file_id: id, name: z.string(), blocks: z.array(blockSchema), warnings: z.array(z.string()), annotations: z.array(z.object({ id, text: z.string(), source_ids: ids })).default([]) })),
  main_document_ids: ids, assets: z.array(assetSchema), revision_view: z.enum(["accepted", "original"]).default("accepted"),
  base_article_id: id.optional(), base_article: parsedArticleSchema.optional(),
  base_draft: z.array(draftNodeSchema).optional(),
  inherited_requests: z.array(imageRequestSchema).optional(),
  image_requests_by_node: z.record(z.string(), id).optional(),
  native_bindings: z.record(z.string(), z.object({ slot_ids: ids, kind: z.enum(["text", "image"]), native_path: z.array(z.number().int().nonnegative()).optional() })).optional(),
  plan: submissionPlanSchema.optional(), draft: z.object({ id, nodes: z.array(draftNodeSchema) }).optional(),
  bindings: z.record(z.string(), bindingSchema).default({}), pending: z.array(pendingSchema).default([]),
  publishing: z.object({ cover_asset_id: id.nullable().optional(), cover_request_id: id.nullable().optional() }).default({}),
  applied: z.boolean().default(false), decisions: z.array(z.object({ id, resolution: z.string() })).default([]),
}).superRefine((state, ctx) => {
  if (state.applied && (!state.plan || !state.draft)) ctx.addIssue({ code: "custom", message: "已应用交稿缺少工作稿或计划" });
  const assetIds = state.assets.map((a) => a.id);
  if (new Set(assetIds).size !== assetIds.length) ctx.addIssue({ code: "custom", message: "素材 ID 重复" });
  for (const binding of Object.values(state.bindings)) if (binding.status === "bound" && !assetIds.includes(binding.asset_id)) ctx.addIssue({ code: "custom", message: "素材绑定指向不存在的资源" });
  if (state.publishing.cover_asset_id && !assetIds.includes(state.publishing.cover_asset_id)) ctx.addIssue({ code: "custom", message: "封面资源缺失" });
  const requests = [...(state.plan?.image_requests ?? []), ...(state.inherited_requests ?? [])];
  for (const nodes of [state.draft?.nodes, state.base_draft]) if (nodes) {
    const ids = nodes.flatMap((node) => [node.id, ...("items" in node ? node.items.map((item) => item.id) : [])]);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "工作稿节点 ID 重复" });
    for (const node of nodes) if (node.type === "image_ref" && !requests.some((r) => r.id === node.request_id)) ctx.addIssue({ code: "custom", message: "工作稿缺少插图需求" });
  }
});
export type Asset = z.infer<typeof assetSchema>;
export type Submission = z.infer<typeof submissionSchema>;
export type SubmissionPlan = z.infer<typeof submissionPlanSchema>;
export type DraftNode = z.infer<typeof draftNodeSchema>;
export type ContentChange = z.infer<typeof changeSchema>;
export type ImageRequest = z.infer<typeof imageRequestSchema>;
export type SourceNode = z.infer<typeof sourceNodeSchema>;
export type ImageBinding = z.infer<typeof bindingSchema>;
