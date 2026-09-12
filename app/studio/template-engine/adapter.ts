import type { ArticleContent } from "../types";
import { plainRichText, richTextToPlain } from "./richtext";
import { parsedArticleSchema, type ArticleNode, type LayoutState, type ParsedArticle, type TemplateDefinition } from "./types";
import { publishTemplate } from "./validate";

/** Adapt only structure already present in the old editor. No heading detection here. */
export function adaptLegacyArticle(content: ArticleContent, articleId: string): ParsedArticle {
  const nodes: ArticleNode[] = [{ id: "legacy-title", type: "article_title", content: plainRichText(content.title) }];
  if (content.subtitle) nodes.push({ id: "legacy-subtitle", type: "subtitle", content: plainRichText(content.subtitle) });
  const paragraphs = (value: string, prefix: string) => value.split(/\n\s*\n/).filter((text) => text.trim()).forEach((text, index) => nodes.push({ id: `${prefix}-p${index + 1}`, type: "paragraph", content: plainRichText(text) }));
  paragraphs(content.lead, "legacy-lead");
  for (const section of content.sections) {
    if (!section.visible) continue;
    const prefix = `legacy-${section.id}`;
    if (section.title.trim()) nodes.push({ id: `${prefix}-heading`, type: "heading1", content: plainRichText(section.title) });
    paragraphs(section.body, prefix);
    if (section.imageUrl.trim()) nodes.push({ id: `${prefix}-image`, type: "image", src: section.imageUrl, alt: "", caption: plainRichText(section.imageCaption) });
    else if (section.imageCaption.trim()) paragraphs(section.imageCaption, `${prefix}-caption`);
  }
  paragraphs(content.ending, "legacy-ending");
  return parsedArticleSchema.parse({ schema: "opslion.article/v1", id: articleId, nodes });
}
export function createLayoutState(article: ParsedArticle, template: TemplateDefinition): LayoutState {
  return { article: parsedArticleSchema.parse(article), template: publishTemplate(template), presetId: template.presets[0]?.id ?? null, overrides: {} };
}
export const articleTitle = (article: ParsedArticle) => {
  const title = article.nodes.find((node) => node.type === "article_title"); return title && "content" in title ? richTextToPlain(title.content) : "";
};

/** A compatibility view for existing clone tools. The rich article remains authoritative. */
export function articleToLegacyContent(article: ParsedArticle): ArticleContent {
  const subtitle = article.nodes.find((node) => node.type === "subtitle");
  return { title: articleTitle(article), subtitle: subtitle && "content" in subtitle ? richTextToPlain(subtitle.content) : "", lead: "", ending: "", sections: article.nodes.filter((node) => !["article_title", "subtitle", "divider"].includes(node.type)).map((node) => ({
    id: node.id, title: node.type.startsWith("heading") && "content" in node ? richTextToPlain(node.content) : "",
    body: "items" in node ? node.items.map((item, index) => `${node.type === "ol" ? `${node.start + index}.` : "•"} ${richTextToPlain(item.content)}`).join("\n") : "content" in node && !node.type.startsWith("heading") ? richTextToPlain(node.content) : "",
    imageUrl: node.type === "image" ? node.src : "", imageCaption: node.type === "image" ? richTextToPlain(node.caption ?? []) : "", visible: true,
  })) };
}
