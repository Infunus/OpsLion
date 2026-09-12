import { templateDefinitionSchema, type ParsedArticle } from "../../app/studio/template-engine/types";
import { plainLayout } from "../../app/studio/template-engine/catalog";
import { numberedHeading, sectionCard } from "../../app/studio/template-engine/basic-components";

// Synthetic inputs for testing the renderer and user template imports.
export const testArticle: ParsedArticle = {
  schema: "opslion.article/v1", id: "test-article",
  nodes: [
    { id: "title", type: "article_title", content: [{ text: "测试文稿" }] },
    { id: "subtitle", type: "subtitle", content: [{ text: "结构验证" }] },
    { id: "intro", type: "paragraph", content: [{ text: "导语测试。" }] },
    { id: "chapter-one", type: "heading1", content: [{ text: "第一节" }] },
    { id: "body-one", type: "paragraph", content: [{ text: "第一段内容。" }] },
    { id: "body-two", type: "paragraph", content: [{ text: "加粗内容", marks: ["bold"] }, { text: "与普通内容。" }] },
    { id: "subsection", type: "heading2", content: [{ text: "第二级标题" }] },
    { id: "quote", type: "quote", content: [{ text: "引用内容。" }] },
    { id: "chapter-two", type: "heading1", content: [{ text: "第二节" }] },
    { id: "list", type: "ul", items: [1, 2, 3].map((n) => ({ id: `item-${n}`, content: [{ text: `测试列表项 ${n}` }] })) },
    { id: "divider", type: "divider" },
    { id: "ending", type: "paragraph", content: [{ text: "结尾内容。" }] },
  ],
};
export const testTemplates = [
  templateDefinitionSchema.parse({ ...plainLayout, id: "test-body", name: "测试正文", examples: [testArticle] }),
  templateDefinitionSchema.parse({
    ...plainLayout, id: "test-sections", name: "测试章节", examples: [testArticle],
    components: { "heading-numbered": numberedHeading, "section-card": sectionCard },
    mapping: { heading1: { component: "heading-numbered", fields: { title: { from: "content" }, number: { counter: "h1" } } } },
    rules: {
      sections: { heading1: { wrapper: "section-card", headingRegion: "heading", bodyRegion: "body" } },
      counters: { h1: { type: "heading1", start: 1, pad: 2, scope: "article" } },
      sequences: { images: { strategy: "balanced-2-3", pair: "image-pair", triple: "image-triple" } },
    },
    presets: [{ id: "gold", name: "金色", values: { accent: "#886600", surface: "#fff8dd" } }],
  }),
];
