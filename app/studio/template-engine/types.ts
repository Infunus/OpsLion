import { z } from "zod";
import { safeImageUrl, safeLinkUrl } from "../html-policy";
import { pageFormatSchema } from "../page-format";
import type { NativeArticle } from "../bridge-contract";

export const nodeKinds = ["article_title", "subtitle", "heading1", "heading2", "heading3", "paragraph", "image", "quote", "ul", "ol", "divider"] as const;
export const headingKinds = ["heading1", "heading2", "heading3"] as const;
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).refine((value) => !["constructor", "prototype", "__proto__"].includes(value), "标识符不能使用保留名称");
const id = z.string().min(1).max(200);
const marks = z.array(z.enum(["bold", "italic", "underline", "strike"]));
const run = z.object({ text: z.string().transform((value) => value.replace(/\r\n?/g, "\n")), marks: marks.optional(), color: z.string().regex(/^#[a-f\d]{6}$/i).optional() }).strict();
export const richTextSchema = z.array(z.union([
  run,
  z.object({ break: z.literal(true) }).strict(),
  z.object({ href: z.string().refine((value) => Boolean(safeLinkUrl(value)), "链接需要有效的 HTTP 或 HTTPS 地址"), content: z.array(run) }).strict(),
]));
const content = richTextSchema;
const imageSource = z.string().refine((value) => Boolean(safeImageUrl(value)), "图片地址无效");
export const articleNodeSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.enum(["article_title", "subtitle", ...headingKinds, "paragraph", "quote"]), content }).strict(),
  z.object({ id, type: z.literal("image"), src: imageSource, alt: z.string().default(""), width: z.number().positive().optional(), height: z.number().positive().optional(), caption: content.optional(), link_url: z.string().refine((value) => Boolean(safeLinkUrl(value)), "图片链接无效").optional(), group: id.optional() }).strict(),
  z.object({ id, type: z.literal("ul"), items: z.array(z.object({ id, content }).strict()) }).strict(),
  z.object({ id, type: z.literal("ol"), start: z.number().int().min(1).default(1), items: z.array(z.object({ id, content }).strict()) }).strict(),
  z.object({ id, type: z.literal("divider") }).strict(),
]);
export const parsedArticleSchema = z.object({ schema: z.literal("opslion.article/v1"), id, nodes: z.array(articleNodeSchema) }).strict().superRefine((article, ctx) => {
  const ids = article.nodes.flatMap((node) => [node.id, ...("items" in node ? node.items.map((item) => item.id) : [])]);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "文章节点与列表项 ID 必须唯一" });
  if (article.nodes[0]?.type !== "article_title" || article.nodes.filter((node) => node.type === "article_title").length !== 1) ctx.addIssue({ code: "custom", message: "文章须以唯一的主标题开始" });
  if (article.nodes.some((node, index) => node.type === "subtitle" && index !== 1)) ctx.addIssue({ code: "custom", message: "副标题须紧随主标题" });
});

const styleBinding = z.object({ part: key, type: z.literal("style"), name: z.string().regex(/^[a-z][a-z-]*$/) }).strict();
const fieldBinding = z.union([
  z.object({ part: key, type: z.enum(["text", "richtext"]), mode: z.enum(["preserve-shell", "replace"]).optional() }).strict(),
  z.object({ part: key, type: z.literal("image") }).strict(),
  z.object({ part: key, type: z.literal("attribute"), name: z.enum(["start", "alt", "title", "width", "height"]) }).strict(),
]);
const field = z.object({ kind: z.enum(["text", "richtext", "image", "number"]), required: z.boolean().default(true), empty: z.enum(["clear", "remove-part"]).default("clear"), bindings: z.array(fieldBinding).min(1) }).strict();
export const fieldSourceSchema = z.union([
  z.object({ from: z.enum(["content", "self", "caption", "start"]) }).strict(),
  z.object({ counter: key }).strict(),
  z.object({ literal: z.union([z.string(), z.number().finite()]) }).strict(),
]);
const fields = z.record(key, fieldSourceSchema);
const region = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flow"), part: key }).strict(),
  z.object({ kind: z.literal("repeat"), part: key, itemComponent: key, fields }).strict(),
]);
export const componentSchema = z.object({
  role: key,
  source: z.object({ kind: z.literal("markup"), html: z.string().min(1) }).strict(),
  layoutPart: key,
  fields: z.record(key, field).default({}),
  parameters: z.record(key, z.object({ token: key, bindings: z.array(styleBinding).min(1) }).strict()).default({}),
  regions: z.record(key, region).default({}),
}).strict();
const condition = z.object({
  typeIndexInArticle: z.number().int().positive().optional(), typeIndexInSection: z.number().int().positive().optional(),
  indexInFlow: z.number().int().positive().optional(), lastInFlow: z.boolean().optional(),
  previousType: z.enum(nodeKinds).nullable().optional(), nextType: z.enum(nodeKinds).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "变体条件不能为空");
const selection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first-match"), variants: z.array(z.object({ when: condition, component: key }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("cycle"), scope: z.enum(["article", "section"]), components: z.array(key).min(1) }).strict(),
]);
const mapping = z.object({ component: key, fields: fields.default({}), regions: z.record(key, z.object({ from: z.literal("items") }).strict()).default({}), selection: selection.optional(), allowedVariants: z.array(key).optional() }).strict();
export const tokenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color"), value: z.string().regex(/^#[a-f\d]{6}$/i), editable: z.boolean().default(false), label: z.string() }).strict(),
  z.object({ kind: z.enum(["length", "number"]), value: z.number().finite().nonnegative(), min: z.number().nonnegative(), max: z.number().nonnegative(), editable: z.boolean().default(false), label: z.string() }).strict(),
]);
const scalar = z.union([z.string(), z.number().finite()]);
const gap = z.union([z.number().finite().nonnegative(), z.object({ token: key }).strict()]);
export const templateDefinitionSchema = z.object({
  schema: z.literal("opslion.layout-template/v1"), id: key, version: z.string().regex(/^\d+\.\d+\.\d+$/), name: z.string().min(1), description: z.string(), tags: z.array(z.string()),
  base: z.literal("opslion.basic/1").nullable().default("opslion.basic/1"),
  page: z.object({ component: key, bodyRegion: key }).strict(),
  pageFormat: pageFormatSchema.optional(),
  tokens: z.record(key, tokenSchema).default({}), presets: z.array(z.object({ id: key, name: z.string(), values: z.record(key, scalar) }).strict()).default([]),
  components: z.record(key, componentSchema).default({}), mapping: z.partialRecord(z.enum(nodeKinds), mapping).default({}),
  rules: z.object({
    sections: z.partialRecord(z.enum(headingKinds), z.object({ wrapper: key, headingRegion: key, bodyRegion: key }).strict()).default({}),
    counters: z.record(key, z.object({ type: z.enum(headingKinds), start: z.number().int().min(1).default(1), pad: z.number().int().min(1).max(8).default(1), scope: z.enum(["article", ...headingKinds]).default("article") }).strict()).default({}),
    sequences: z.object({ images: z.object({ strategy: z.enum(["balanced-2-3", "greedy-3"]), pair: key, triple: key }).strict().optional() }).strict().default({}),
    spacing: z.object({ default: gap, pairs: z.record(z.string().regex(/^[a-zA-Z0-9_-]+>[a-zA-Z0-9_-]+$/), gap).default({}) }).strict().default({ default: 16, pairs: {} }),
    decorations: z.array(z.object({ position: z.enum(["article-start", "article-end", "between-sections"]), level: z.enum(headingKinds).optional(), component: key, fields: fields.default({}) }).strict()).default([]),
  }).strict().default({ sections: {}, counters: {}, sequences: {}, spacing: { default: 16, pairs: {} }, decorations: [] }),
  assets: z.record(key, imageSource).default({}), examples: z.array(parsedArticleSchema).min(1),
}).strict();
export const layoutStateSchema = z.object({
  article: parsedArticleSchema, template: templateDefinitionSchema, presetId: key.nullable().default(null), overrides: z.record(key, scalar).default({}),
  nodeVariants: z.record(z.string(), key).optional(),
}).strict();

export type RichText = z.infer<typeof richTextSchema>;
export type ArticleNode = z.infer<typeof articleNodeSchema>;
export type ParsedArticle = z.infer<typeof parsedArticleSchema>;
export type NodeKind = typeof nodeKinds[number];
export type HeadingKind = typeof headingKinds[number];
export type ComponentDefinition = z.infer<typeof componentSchema>;
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type Mapping = z.infer<typeof mapping>;
export type FieldSource = z.infer<typeof fieldSourceSchema>;
export type LayoutState = z.infer<typeof layoutStateSchema>;
export type Token = z.infer<typeof tokenSchema>;
export type ImageNode = Extract<ArticleNode, { type: "image" }>;
export type FieldValue = string | number | RichText | ImageNode | undefined;
export interface SemanticContext { typeIndexInArticle: number; typeIndexInSection: number; indexInFlow: number; flowLength: number; previousType: NodeKind | null; nextType: NodeKind | null; ancestors: string[] }
export interface PlanInstance { id: string; component: string; role: string; primarySources: string[]; fields: Record<string, FieldValue>; regions: Record<string, PlanInstance[]>; gap: number }
export interface LayoutPlan { articleId: string; templateId: string; version: string; page: PlanInstance; sourceOrder: string[] }
export interface LayoutResult { html: string; plan: LayoutPlan; instanceCount: number; native?: NativeArticle }
