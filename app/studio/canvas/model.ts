import { makeId } from "../types";
import { parsedArticleSchema, plainRichText, type ArticleNode, type NodeKind, type ParsedArticle, type RichText } from "../template-engine";

export const moduleLabels: Record<NodeKind, string> = { article_title: "篇名", subtitle: "副标题", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", paragraph: "正文", quote: "引用", ul: "无序列表", ol: "有序列表", divider: "分割线", image: "图片" };
export function createModule(type: NodeKind, src?: string): ArticleNode {
  const id = makeId("node");
  if (type === "image") { if (!src) throw new Error("请选择要插入的图片"); return { id, type, src, alt: "", caption: [] }; }
  if (type === "divider") return { id, type };
  if (type === "ul" || type === "ol") return { id, type, ...(type === "ol" ? { start: 1 } : {}), items: [{ id: makeId("item"), content: [] }] } as ArticleNode;
  return { id, type, content: plainRichText("") };
}
export function insertModules(article: ParsedArticle, nodes: ArticleNode[], anchor: string | null, position: "before" | "after"): ParsedArticle {
  const next = [...article.nodes];
  if (nodes.some((node) => node.type === "article_title")) throw new Error("每篇文章使用一个篇名，请编辑已有篇名");
  if (nodes.some((node) => node.type === "subtitle")) {
    if (nodes.length !== 1 || next.some((node) => node.type === "subtitle")) throw new Error("已有副标题，请编辑原位置");
    next.splice(1, 0, ...nodes);
  } else {
    const index = anchor === null ? next.length : next.findIndex((node) => node.id === anchor);
    if (index < 0) throw new Error("插入位置已不存在，请重新选择位置");
    const start = next[1]?.type === "subtitle" ? 2 : 1;
    next.splice(Math.max(start, index + (anchor !== null && position === "after" ? 1 : 0)), 0, ...nodes);
  }
  return parsedArticleSchema.parse({ ...article, nodes: next });
}
export function changeModule(article: ParsedArticle, id: string, operation: "delete" | "duplicate" | "up" | "down") {
  const nodes = [...article.nodes]; const index = nodes.findIndex((node) => node.id === id); const node = nodes[index];
  if (!node) return article;
  if (operation === "delete") {
    if (node.type === "article_title") nodes[index] = { ...node, content: [] }; else nodes.splice(index, 1);
  } else if (node.type === "article_title" || node.type === "subtitle") throw new Error("篇名与副标题使用固定位置");
  else if (operation === "duplicate") { const copy = structuredClone(node); copy.id = makeId("node"); if (copy.type === "image") copy.group = copy.id; if ("items" in copy) copy.items = copy.items.map((item) => ({ ...item, id: makeId("item") })); nodes.splice(index + 1, 0, copy); }
  else {
    const target = index + (operation === "up" ? -1 : 1);
    if (target < (nodes[1]?.type === "subtitle" ? 2 : 1) || target >= nodes.length) return article;
    [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
  }
  return parsedArticleSchema.parse({ ...article, nodes });
}
export function changeRichText(article: ParsedArticle, source: string, field: string, content: RichText): ParsedArticle {
  return { ...article, nodes: article.nodes.map((node) => {
    if (node.id === source) {
      if (field === "caption" && node.type === "image") return { ...node, caption: content };
      if (field === "content" && "content" in node) return { ...node, content };
    }
    return "items" in node ? { ...node, items: node.items.map((item) => item.id === source ? { ...item, content } : item) } : node;
  }) };
}
export async function readImageFile(file: File) {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) || file.size > 5 * 1024 * 1024) throw new Error("请选择 5MB 以内的 PNG、JPEG、GIF、WebP 或 AVIF 图片");
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file); });
}
