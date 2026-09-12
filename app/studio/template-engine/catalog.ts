import { templateDefinitionSchema, type ParsedArticle, type TemplateDefinition } from "./types";

export const standardArticle: ParsedArticle = {
  schema: "opslion.article/v1", id: "preview-example",
  nodes: [
    { id: "title", type: "article_title", content: [{ text: "示例标题" }] },
    { id: "heading", type: "heading1", content: [{ text: "内容小节" }] },
    { id: "body", type: "paragraph", content: [{ text: "这是一段用于检查导入模板的示例正文。" }] },
  ],
};

// The editor needs a base renderer before a user imports a template.
// It is not a release in the template library.
export const plainLayout = templateDefinitionSchema.parse({
  schema: "opslion.layout-template/v1", id: "opslion-plain", version: "1.0.0",
  name: "基础排版", description: "使用基础文本与图片组件排版。", tags: [],
  page: { component: "page", bodyRegion: "main" }, examples: [standardArticle],
});

export const builtinTemplates: TemplateDefinition[] = [];
