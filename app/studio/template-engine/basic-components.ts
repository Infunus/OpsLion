import { componentSchema, type ComponentDefinition, type Mapping, type NodeKind, type Token } from "./types";

const richField = (part: string, required = true) => ({ kind: "richtext", required, empty: required ? "clear" : "remove-part", bindings: [{ part, type: "richtext" }] });
const parameter = (token: string, part: string, name: string) => ({ token, bindings: [{ part, type: "style" as const, name }] });
export function textComponent(role: string, tag: string, style: string, extra?: { part: string; html: string }) {
  return componentSchema.parse({ role, layoutPart: "root", source: { kind: "markup", html: `<section data-layout-part="root" style="margin:0;padding:0;">${extra?.html ?? ""}<${tag} data-layout-part="body" style="margin:0;overflow-wrap:break-word;${style}"></${tag}></section>` }, fields: { body: richField("body") }, parameters: { color: parameter(role === "subtitle" ? "mutedText" : "text", "body", "color") } });
}
export const basicTokens: Record<string, Token> = {
  accent: { kind: "color", value: "#526b5c", editable: true, label: "强调色" },
  text: { kind: "color", value: "#303832", editable: true, label: "正文颜色" },
  mutedText: { kind: "color", value: "#747a73", editable: false, label: "辅助文字" },
  paper: { kind: "color", value: "#ffffff", editable: true, label: "文章背景" },
  surface: { kind: "color", value: "#f2f4ef", editable: false, label: "章节背景" },
  bodySize: { kind: "length", value: 15, min: 12, max: 22, editable: true, label: "正文字号" },
  bodyLineHeight: { kind: "number", value: 1.9, min: 1.3, max: 2.6, editable: true, label: "正文行高" },
  pagePaddingX: { kind: "length", value: 22, min: 8, max: 36, editable: true, label: "左右留白" },
  paragraphGap: { kind: "length", value: 16, min: 0, max: 36, editable: true, label: "段落间距" },
};
const bodyParameters = { color: parameter("text", "body", "color"), size: parameter("bodySize", "body", "font-size"), line: parameter("bodyLineHeight", "body", "line-height") };
const figure = (role: string, cellWidth?: string): ComponentDefinition => componentSchema.parse({
  role, layoutPart: "root", source: { kind: "markup", html: `<section data-layout-part="root" style="margin:0;box-sizing:border-box;${cellWidth ? `display:inline-block;vertical-align:top;width:${cellWidth};padding:0 4px;` : "padding:0;"}"><figure style="margin:0;"><img data-layout-part="image" style="display:block;width:100%;height:auto;border-radius:4px;"/><figcaption data-layout-part="caption" style="margin:0;padding:8px 0 0;font-size:12px;line-height:1.6;text-align:center;overflow-wrap:break-word;"></figcaption></figure></section>` },
  fields: { image: { kind: "image", bindings: [{ part: "image", type: "image" }] }, caption: richField("caption", false) },
  parameters: { captionColor: parameter("mutedText", "caption", "color") },
});
const collection = (role: string, html: string, itemComponent: string, fields: Record<string, unknown>) => componentSchema.parse({ role, layoutPart: "root", source: { kind: "markup", html }, regions: { items: { kind: "repeat", part: "items", itemComponent, fields } } });
export const basicComponents: Record<string, ComponentDefinition> = {
  page: componentSchema.parse({ role: "page", layoutPart: "root", source: { kind: "markup", html: '<section data-layout-part="root" style="max-width:100%;margin:0;padding:32px 22px 40px;box-sizing:border-box;font-size:15px;line-height:1.9;font-weight:400;text-align:left;letter-spacing:normal;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;"><section data-layout-part="main"></section></section>' }, regions: { main: { kind: "flow", part: "main" } }, parameters: { background: parameter("paper", "root", "background-color"), left: parameter("pagePaddingX", "root", "padding-left"), right: parameter("pagePaddingX", "root", "padding-right") } }),
  "article-title": textComponent("article_title", "h1", "font-size:28px;line-height:1.45;font-weight:700;letter-spacing:-.5px;"),
  subtitle: textComponent("subtitle", "p", "font-size:13px;line-height:1.7;"),
  heading1: textComponent("heading1", "h2", "font-size:21px;line-height:1.5;font-weight:700;"),
  heading2: textComponent("heading2", "h3", "font-size:18px;line-height:1.5;font-weight:700;"),
  heading3: textComponent("heading3", "h4", "font-size:16px;line-height:1.5;font-weight:700;"),
  body: { ...textComponent("paragraph", "p", "font-size:15px;line-height:1.9;text-align:justify;"), parameters: bodyParameters },
  "body-emphasis": { ...textComponent("paragraph", "p", "font-size:15px;line-height:1.9;padding:12px 16px;border-left:3px solid #526b5c;background:#f2f4ef;"), parameters: { ...bodyParameters, accent: parameter("accent", "body", "border-left-color"), background: parameter("surface", "body", "background-color") } },
  quote: componentSchema.parse({ role: "quote", layoutPart: "root", source: { kind: "markup", html: '<blockquote data-layout-part="root" style="margin:0;padding:14px 16px;border-left:3px solid #526b5c;background:#f2f4ef;"><p data-layout-part="body" style="margin:0;font-size:15px;line-height:1.9;overflow-wrap:break-word;"></p></blockquote>' }, fields: { body: richField("body") }, parameters: { ...bodyParameters, accent: parameter("accent", "root", "border-left-color"), background: parameter("surface", "root", "background-color") } }),
  figure: figure("image"),
  "image-cell-pair": figure("image", "50%"),
  "image-cell-triple": figure("image", "33.333333%"),
  "image-pair": collection("image_group", '<section data-layout-part="root" style="margin:0;padding:0;"><section data-layout-part="items" style="font-size:0;margin:0 -4px;"></section></section>', "image-cell-pair", { image: { from: "self" }, caption: { from: "caption" } }),
  "image-triple": collection("image_group", '<section data-layout-part="root" style="margin:0;padding:0;"><section data-layout-part="items" style="font-size:0;margin:0 -4px;"></section></section>', "image-cell-triple", { image: { from: "self" }, caption: { from: "caption" } }),
  "bullet-item": componentSchema.parse({ role: "list_item", layoutPart: "body", source: { kind: "markup", html: '<li data-layout-part="body" style="margin:0;padding:3px 0;font-size:15px;line-height:1.9;overflow-wrap:break-word;"></li>' }, fields: { body: richField("body") }, parameters: bodyParameters }),
  "bullet-list": collection("ul", '<ul data-layout-part="root" style="margin:0;padding:0 0 0 24px;list-style-type:disc;"><!--items--></ul>'.replace('data-layout-part="root"', 'data-layout-part="items"'), "bullet-item", { body: { from: "content" } }),
  "ordered-list": collection("ol", '<ol data-layout-part="items" style="margin:0;padding:0 0 0 24px;list-style-type:decimal;"></ol>', "bullet-item", { body: { from: "content" } }),
  divider: componentSchema.parse({ role: "divider", layoutPart: "root", source: { kind: "markup", html: '<section data-layout-part="root" style="margin:0;padding:10px 0;"><hr data-layout-part="line" style="margin:0;border:0;border-top:1px solid #526b5c;opacity:.3;"/></section>' }, parameters: { color: parameter("accent", "line", "border-top-color") } }),
};
// List roots are also their repeat regions; no extra block may sit between ul/ol and li.
basicComponents["bullet-list"].layoutPart = "items";
basicComponents["ordered-list"].layoutPart = "items";
basicComponents["ordered-list"].fields = { start: { kind: "number", required: true, empty: "clear", bindings: [{ part: "items", type: "attribute", name: "start" }] } };
const textMapping = (component: string): Mapping => ({ component, fields: { body: { from: "content" } }, regions: {} });
export const basicMapping: Record<NodeKind, Mapping> = {
  article_title: textMapping("article-title"), subtitle: textMapping("subtitle"), heading1: textMapping("heading1"), heading2: textMapping("heading2"), heading3: textMapping("heading3"), paragraph: textMapping("body"), quote: textMapping("quote"),
  image: { component: "figure", fields: { image: { from: "self" }, caption: { from: "caption" } }, regions: {} },
  divider: { component: "divider", fields: {}, regions: {} },
  ul: { component: "bullet-list", fields: {}, regions: { items: { from: "items" } } },
  ol: { component: "ordered-list", fields: { start: { from: "start" } }, regions: { items: { from: "items" } } },
};

basicMapping.paragraph.allowedVariants = ["body-emphasis"];

export const numberedHeading = componentSchema.parse({ role: "heading1", layoutPart: "root", source: { kind: "markup", html: '<section data-layout-part="root" style="margin:0;padding:0;"><p data-layout-part="number" style="margin:0 0 7px;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:2px;"></p><h2 data-layout-part="title" style="margin:0;font-size:21px;line-height:1.5;font-weight:700;overflow-wrap:break-word;"></h2></section>' }, fields: { title: richField("title"), number: { kind: "text", bindings: [{ part: "number", type: "text" }] } }, parameters: { number: parameter("accent", "number", "color"), title: parameter("text", "title", "color") } });
export const sectionCard = componentSchema.parse({ role: "section_heading1", layoutPart: "root", source: { kind: "markup", html: '<section data-layout-part="root" style="margin:0;padding:22px 18px;border-radius:12px;box-sizing:border-box;"><section data-layout-part="heading"></section><section data-layout-part="body" style="padding-top:18px;"></section></section>' }, parameters: { background: parameter("surface", "root", "background-color") }, regions: { heading: { kind: "flow", part: "heading" }, body: { kind: "flow", part: "body" } } });
