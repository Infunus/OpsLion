import { z } from "zod";
import { adaptLegacyArticle, parsedArticleSchema, type ArticleNode, type ParsedArticle, type RichText } from "./template-engine";
import type { StudioProject } from "./types";
import { wordConversions } from "./word-conversion";

export interface SemanticBlock {
  id: string;
  kind: "paragraph" | "image" | "divider";
  content: RichText;
  clues: Record<string, unknown>;
  image_anchor_id?: string;
  caption?: RichText;
}
export interface SemanticBundle {
  request: { task: "parse_article_semantics"; source: { schema: "opslion/word-snapshot/v1" | "opslion/editor-snapshot/v1"; document_name: string; blocks: SemanticBlock[]; warnings: string[]; annotations?: Array<{ id: string; text: string; source_ids: string[] }> } };
  images: Map<string, Extract<ArticleNode, { type: "image" }>>;
}
export const semanticPlanSchema = z.object({
  schema: z.literal("opslion/semantic-plan/v1"),
  nodes: z.array(z.object({
    type: z.enum(["article_title", "subtitle", "heading1", "heading2", "heading3", "paragraph", "quote", "image", "ul", "ol", "divider"]),
    source_ids: z.array(z.string().min(1)).min(1),
  }).strict()),
}).strict();
export type SemanticPlan = z.infer<typeof semanticPlanSchema>;

export function createEditorSemanticRequest(project: StudioProject): SemanticBundle {
  const article = project.layout?.article ?? adaptLegacyArticle(project.content, project.id);
  const blocks: SemanticBlock[] = [];
  const images: SemanticBundle["images"] = new Map();
  for (const node of article.nodes) {
    if (node.type === "image") {
      images.set(node.id, node);
      blocks.push({ id: node.id, kind: "image", content: [], caption: node.caption, image_anchor_id: node.id, clues: {} });
    } else if ("items" in node) {
      node.items.forEach((item, index) => blocks.push({ id: item.id, kind: "paragraph", content: item.content, clues: { semantic_type: node.type, numbering: { group: node.id, level: 0, ordered: node.type === "ol", start: node.type === "ol" ? node.start + index : 1 } } }));
    } else blocks.push({ id: node.id, kind: node.type === "divider" ? "divider" : "paragraph", content: "content" in node ? node.content : [], clues: { semantic_type: node.type } });
  }
  return { request: { task: "parse_article_semantics", source: { schema: "opslion/editor-snapshot/v1", document_name: project.name, blocks, warnings: ["这是当前编辑稿；旧式自动分析已经省略的 Word 信息不能恢复。需要原始格式时请使用模型解析 Word。"] } }, images };
}

// The model labels sources. Original text, marks, links and image bytes never come back from it.
export function applySemanticPlan(value: unknown, bundle: SemanticBundle, articleId: string): ParsedArticle {
  const plan = semanticPlanSchema.parse(value);
  const blocks = bundle.request.source.blocks;
  const conversions = wordConversions(blocks);
  if (conversions.length) throw new Error(`请先通过“导入 Word”逐项核对 ${conversions.map((c) => c.location).join("、")}，再对当前稿智能整理；已保留其他段落的完整内容。`);
  const sources = plan.nodes.flatMap((node) => node.source_ids);
  if (JSON.stringify(sources) !== JSON.stringify(blocks.map((block) => block.id))) throw new Error("模型改变了来源顺序，或遗漏、重复了内容");
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const nodes: ArticleNode[] = plan.nodes.map((node, index) => {
    const selected = node.source_ids.map((id) => byId.get(id)!);
    const first = selected[0];
    const id = `semantic-${index + 1}`;
    if (node.type === "image") {
      const image = bundle.images.get(first.image_anchor_id || "");
      if (first.kind !== "image" || !image || selected.slice(1).some((item) => item.kind !== "paragraph" || item.clues.numbering) || (selected.length > 1 && first.caption?.length)) throw new Error("模型图片引用或图注绑定无效");
      return { ...image, id, caption: selected.length > 1 ? selected.slice(1).flatMap((item, i) => i ? [{ break: true as const }, ...item.content] : item.content) : first.caption ?? image.caption };
    }
    if (node.type === "divider") {
      if (selected.length !== 1 || first.kind !== "divider") throw new Error("模型不能添加分割线或删除原有文字");
      return { id, type: "divider" };
    }
    if (selected.some((item) => item.kind !== "paragraph")) throw new Error("模型不能把图片或分割线变成正文");
    if (node.type === "ul" || node.type === "ol") {
      const numbers = selected.map((item) => item.clues.numbering as { group?: string; level?: number; ordered?: boolean; start?: number } | undefined);
      if (numbers.some((n) => !n || n.level !== 0 || n.ordered !== (node.type === "ol") || n.group !== numbers[0]?.group)) throw new Error("模型不能凭空创建列表或合并不同列表");
      const items = selected.map((item, i) => ({ id: `${id}-item-${i + 1}`, content: item.content }));
      return node.type === "ol" ? { id, type: "ol", start: numbers[0]?.start ?? 1, items } : { id, type: "ul", items };
    }
    if (selected.length !== 1) throw new Error("普通段落和标题必须逐段保留");
    const numbering = first.clues.numbering as { label?: string } | undefined;
    if (numbering && !node.type.startsWith("heading")) throw new Error("自动编号段落须保留为列表或章节标题");
    return { id, type: node.type, content: numbering?.label ? [{ text: `${numbering.label} ` }, ...first.content] : first.content };
  });
  if (!nodes.some((node) => node.type === "article_title")) nodes.unshift({ id: "semantic-empty-title", type: "article_title", content: [] });
  return parsedArticleSchema.parse({ schema: "opslion.article/v1", id: articleId, nodes });
}
