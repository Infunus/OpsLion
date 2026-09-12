import { parsedArticleSchema, plainRichText, richTextToPlain, type ArticleNode, type ParsedArticle } from "./template-engine";
import type { SemanticBundle, SemanticBlock } from "./semantic-agent";

export type WordConversion = { id: string; location: string; reasons: string[] };
export function wordBlockContent(block: SemanticBlock) {
  const table = block.clues.table as { row: number; column: number } | undefined;
  return table ? [...plainRichText(`第 ${table.row} 行 · 第 ${table.column} 列：`), ...block.content] : block.content;
}
export function wordConversions(blocks: SemanticBlock[]) {
  const issues = new Map<string, WordConversion>();
  for (const block of blocks) if (block.clues.conversion) { const item = block.clues.conversion as WordConversion; if (!issues.has(item.id)) issues.set(item.id, item); }
  return [...issues.values()];
}
export function wordArticle(bundle: SemanticBundle, articleId: string, decisions: Record<string, "text" | "exclude"> = {}): ParsedArticle {
  const nodes: ArticleNode[] = [];
  let previousNumber = "";
  for (const block of bundle.request.source.blocks) {
    const conversion = block.clues.conversion as WordConversion | undefined;
    if (conversion && decisions[conversion.id] === "exclude") continue;
    if (block.kind === "image") { const image = bundle.images.get(block.image_anchor_id!); if (image) nodes.push({ ...image, id: block.id }); previousNumber = ""; continue; }
    if (block.kind === "divider") { nodes.push({ id: block.id, type: "divider" }); continue; }
    const style = String(block.clues.style_name ?? block.clues.style_id ?? "").toLowerCase();
    const properties = block.clues.paragraph_properties as { outlineLvl?: string } | undefined;
    const level = properties?.outlineLvl !== undefined ? Number(properties.outlineLvl) + 1 : Number(style.match(/(?:heading|标题)\s*([1-6])/)?.[1] ?? 0);
    const numbering = block.clues.numbering as { group: string; level: number; ordered: boolean; start: number; format?: string; label?: string } | undefined;
    const table = block.clues.table as { row: number; column: number } | undefined;
    const content = wordBlockContent(block);
    if (numbering && numbering.level === 0 && ["decimal", "bullet"].includes(numbering.format ?? "decimal") && !level) {
      const previous = nodes.at(-1);
      if (previousNumber === numbering.group && previous && "items" in previous && (previous.type === "ul" || previous.start + previous.items.length === numbering.start)) previous.items.push({ id: block.id, content });
      else nodes.push(numbering.ordered ? { id: `${block.id}:list`, type: "ol", start: numbering.start, items: [{ id: block.id, content }] } : { id: `${block.id}:list`, type: "ul", items: [{ id: block.id, content }] });
      previousNumber = numbering.group; continue;
    }
    previousNumber = "";
    const type = !nodes.length && !table && (!level || level === 1 || /^(title|标题)$/.test(style)) && richTextToPlain(content).length <= 100 ? "article_title" : level ? `heading${Math.min(3, level)}` as "heading1" | "heading2" | "heading3" : "paragraph";
    nodes.push({ id: block.id, type, content: numbering?.label ? [...plainRichText(`${numbering.label} `), ...content] : content });
  }
  if (nodes[0]?.type !== "article_title") nodes.unshift({ id: `${articleId}:title`, type: "article_title", content: plainRichText(bundle.request.source.document_name.replace(/\.docx$/i, "")) });
  return parsedArticleSchema.parse({ schema: "opslion.article/v1", id: articleId, nodes });
}
