import { z } from "zod";
import { sanitizeArticleHtml, safeImageUrl, safeLinkUrl } from "./html-policy";
import type { StudioProject } from "./types";
import { layoutStateSchema, richTextSchema } from "./template-engine/types";
import { resolveTemplate, resolveTokens } from "./template-engine/validate";
import { submissionSchema } from "./submission/types";
import { captureSourceSchema, sourceLocationSchema } from "./bridge-contract";
import { workflowSchema } from "./workflow/types";

const id = z.string().min(1).max(200);
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)), "日期无效");
const text = z.string();
const image = text.transform(safeImageUrl);
const link = text.transform(safeLinkUrl);
const section = z.object({ id, title: text, body: text, imageUrl: image.default(""), imageCaption: text.default(""), visible: z.boolean().default(true) });
const slot = z.object({
  richContent: richTextSchema.optional(),
  id, label: text, kind: z.enum(["text", "image"]), value: text, originalValue: text,
  prefix: text.optional(), suffix: text.optional(), linkUrl: link.optional(), originalLinkUrl: link.optional(),
  role: z.enum(["content", "content_image", "decoration", "unknown"]).optional(),
  sourceLocation: sourceLocationSchema.optional(),
}).transform((value) => value.kind === "image" ? { ...value, value: safeImageUrl(value.value), originalValue: safeImageUrl(value.originalValue) } : value);
const unique = <T extends { id: string }>(items: T[]) => new Set(items.map((item) => item.id)).size === items.length;
const layout = layoutStateSchema.superRefine((value, ctx) => {
  try { resolveTokens(resolveTemplate(value.template), value.presetId, value.overrides); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "模板定义无效" }); }
}).transform((value) => ({ ...value, template: resolveTemplate(value.template) }));
export const cloneTemplateSchema = z.object({
  unplacedContent: z.array(z.object({ id, kind: text, text, content: richTextSchema.optional() })).optional(),
  excludedContent: z.array(z.object({ id, text, reason: text.min(1) })).optional(),
  name: text, sourceHtml: text.transform(sanitizeArticleHtml), analyzedHtml: text.transform(sanitizeArticleHtml),
  slots: z.array(slot).max(10_000).refine(unique, "替换位 ID 重复"),
  modules: z.array(z.object({ id, label: text, included: z.boolean(), repeatable: z.boolean() })).max(5000).refine(unique, "模块 ID 重复"),
  pendingAssets: z.array(z.object({ id, kind: z.literal("image"), purpose: text, preferredSlotId: text.optional(), reason: text, imageUrl: image.optional(), imageCaption: text.optional() })).optional(),
  draftWarnings: z.array(text).optional(), analyzedAt: date,
  source: captureSourceSchema.optional(),
});
export const projectSchema = z.object({
  workflow: workflowSchema.optional(),
  id, name: text, mode: z.enum(["compose", "clone"]).default("compose"),
  theme: z.enum(["plain", "warm", "formal", "vibrant"]).default("plain"), density: z.enum(["compact", "comfortable"]).default("comfortable"),
  accentOverride: text.default("").transform((value) => /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(value) ? value : ""),
  content: z.object({ title: text, subtitle: text.default(""), lead: text.default(""), sections: z.array(section).max(5000).refine(unique, "内容模块 ID 重复"), ending: text.default("") }),
  cloneTemplate: cloneTemplateSchema.nullable().default(null), layout: layout.nullable().optional(), submission: submissionSchema.nullable().optional(), createdAt: date, updatedAt: date,
});
export const savedTemplateSchema = z.object({ id, name: text, template: cloneTemplateSchema, createdAt: date, updatedAt: date });
export const weeklyDraftSchema = z.object({
  preparedCopy: z.object({ name: text, format: z.enum(["markdown", "text"]), text, importedAt: date }).nullable().default(null),
  startDate: text.default(""), endDate: text.default(""),
  pendingExport: z.object({ jobId: id, startDate: text, endDate: text }).nullable().default(null),
});
export type WeeklyDraft = z.infer<typeof weeklyDraftSchema>;
export function parseProjectFile(payload: unknown): StudioProject {
  const envelope = z.object({ schema: z.literal("wechat-agent-studio/project-v1").optional(), project: z.unknown().optional() }).passthrough().parse(payload);
  const project = projectSchema.parse(envelope.project ?? payload);
  // Legacy signoff metadata has no role in an imported workstation project.
  if (project.workflow) delete project.workflow.reviews;
  return project;
}
