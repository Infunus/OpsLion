import { sanitizeArticleHtml, safeImageUrl, safeLinkUrl } from "../html-policy";
import { renderRichText, richTextToPlain } from "./richtext";
import { parsedArticleSchema, richTextSchema, type FieldValue, type LayoutResult, type PlanInstance, type TemplateDefinition } from "./types";
import { LayoutError, publishTemplate, resolveTokens } from "./validate";
import { planArticle } from "./plan";
import { copyEditingBindings } from "./editing-bindings";
import { contentFieldTarget } from "./field-target";
import { partitionNativeArticle } from "../bridge-contract";

export function compileArticle(input: unknown, definition: TemplateDefinition, presetId: string | null = null, overrides: Record<string, string | number> = {}, options: { editing?: boolean; native?: boolean; nodeVariants?: Record<string, string> } = {}): LayoutResult {
  const article = parsedArticleSchema.parse(input);
  const template = publishTemplate(definition); const tokens = resolveTokens(template, presetId, overrides);
  const plan = planArticle(article, template, tokens, options.nodeVariants); let instanceCount = 0;
  const doc = document.implementation.createHTMLDocument("");
  const sources = new Map(article.nodes.flatMap((node) => [{ id: node.id, owner: node.id, value: node }, ...("items" in node ? node.items.map((item) => ({ id: item.id, owner: node.id, value: item })) : [])].map((item) => [item.id, item] as const)));
  const outputText: string[] = []; const outputImages: string[] = [];
  let pageBody: HTMLElement | undefined;
  const empty = (value: FieldValue) => value === undefined || value === "" || (Array.isArray(value) && richTextToPlain(value).length === 0);
  const render = (item: PlanInstance, inFlow: boolean): Element => {
    instanceCount++;
    const component = template.components[item.component]; const holder = doc.createElement("template"); holder.innerHTML = component.source.html;
    const root = holder.content.firstElementChild! as HTMLElement;
    for (const element of [root, ...root.querySelectorAll("*")]) for (const name of ["data-op-node", "data-op-source", "data-op-field"]) element.removeAttribute(name);
    const source = item.primarySources.length === 1 ? sources.get(item.primarySources[0]) : undefined;
    if (options.editing && source) { root.setAttribute("data-op-node", source.owner); root.setAttribute("data-op-source", source.id); }
    const parts = new Map([...holder.content.querySelectorAll("[data-layout-part]")].map((element) => [element.getAttribute("data-layout-part")!, element as HTMLElement]));
    const part = (name: string) => { const element = parts.get(name); if (!element) throw new LayoutError(`${item.component} 缺少部件 ${name}`); return element; };
    for (const parameter of Object.values(component.parameters)) {
      const token = template.tokens[parameter.token]; const value = token.kind === "length" ? `${tokens[parameter.token]}px` : String(tokens[parameter.token]);
      for (const binding of parameter.bindings) { const target = part(binding.part); target.style.setProperty(binding.name, value); if (!target.style.getPropertyValue(binding.name)) throw new LayoutError(`${item.component} 的参数 ${parameter.token} 无法应用到 ${binding.name}`); }
    }
    for (const [name, field] of Object.entries(component.fields)) {
      const value = item.fields[name];
      if (value === undefined && field.required) throw new LayoutError(`${item.component} 缺少必填内容 ${name}（${item.primarySources.join("、")}）`);
      for (const binding of field.bindings) {
        const bound = part(binding.part);
        const target = binding.type === "text" || binding.type === "richtext" ? contentFieldTarget(bound, binding.mode) : bound;
        const editableField = source && "content" in source.value && value === source.value.content ? "content" : source && "type" in source.value && source.value.type === "image" && binding.type === "richtext" && value === source.value.caption ? "caption" : undefined;
        if (options.editing && binding.type === "richtext" && editableField && source) { target.setAttribute("data-op-field", editableField); target.setAttribute("data-op-source", source.id); target.setAttribute("data-op-node", source.owner); }
        if (empty(value) && !field.required && field.empty === "remove-part" && !(options.editing && editableField)) { bound.remove(); continue; }
        if (binding.type === "richtext") { const parsed = richTextSchema.parse(value ?? []); target.replaceChildren(renderRichText(doc, parsed)); outputText.push(target.textContent ?? ""); }
        else if (binding.type === "text") { if (value !== undefined && typeof value !== "string" && typeof value !== "number") throw new LayoutError(`${item.component}.${name} 需要普通文本`); target.textContent = String(value ?? ""); outputText.push(target.textContent); }
        else if (binding.type === "image") {
          if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "image") throw new LayoutError(`${item.component}.${name} 需要图片对象`);
          target.setAttribute("src", safeImageUrl(value.src)); target.setAttribute("alt", value.alt);
          if (value.link_url) { const anchor = doc.createElement("a"); anchor.setAttribute("href", safeLinkUrl(value.link_url)); target.replaceWith(anchor); anchor.append(target); }
          if (value.width) target.setAttribute("width", String(value.width)); if (value.height) target.setAttribute("height", String(value.height)); outputImages.push(safeImageUrl(value.src));
        } else if (binding.type === "attribute") {
          if (value !== undefined && !["string", "number"].includes(typeof value)) throw new LayoutError(`${item.component}.${name} 需要标量属性`);
          if (value === undefined) target.removeAttribute(binding.name); else target.setAttribute(binding.name, String(value));
        }
      }
    }
    for (const [name, region] of Object.entries(component.regions)) {
      const target = part(region.part); const children = item.regions[name] ?? [];
      if (item === plan.page && name === template.page.bodyRegion) pageBody = target;
      target.replaceChildren(...children.map((child) => render(child, region.kind === "flow")));
      if (region.kind === "repeat" && /^(UL|OL)$/.test(target.tagName) && [...target.children].some((child) => child.tagName !== "LI")) throw new LayoutError(`${item.component} 的列表必须直接包含 li`);
      if (!children.length && region.kind === "flow") target.style.paddingTop = "0";
    }
    parts.forEach((element) => element.removeAttribute("data-layout-part"));
    if (!inFlow) return root;
    const wrapper = doc.createElement("section"); wrapper.style.cssText = `margin:0;padding:${item.gap}px 0 0;`; wrapper.append(root); return wrapper;
  };
  const root = render(plan.page, false); root.setAttribute("data-layout-artifact", "opslion-layout-v1");
  if (template.pageFormat) {
    const style = (root as HTMLElement).style;
    for (const [property, value] of Object.entries(template.pageFormat.styles)) style.setProperty(property, value);
    const explicit = { ...(template.presets.find((preset) => preset.id === presetId)?.values ?? {}), ...overrides };
    const properties: Record<string, string[]> = { paper: ["background-color"], text: ["color"], bodySize: ["font-size"], bodyLineHeight: ["line-height"], pagePaddingX: ["padding-left", "padding-right"] };
    for (const [name, value] of Object.entries(explicit)) for (const property of properties[name] ?? []) style.setProperty(property, `${value}${template.tokens[name].kind === "length" ? "px" : ""}`);
  }
  const before = root.outerHTML; const html = sanitizeArticleHtml(before);
  const clean = doc.createElement("template"); clean.innerHTML = html;
  // Compare all rendered text and image sources after the shared export policy.
  if (clean.content.textContent !== root.textContent || JSON.stringify([...clean.content.querySelectorAll("img")].map((image) => image.getAttribute("src"))) !== JSON.stringify([...root.querySelectorAll("img")].map((image) => image.getAttribute("src")))) throw new LayoutError("HTML 清理改变了文章内容，请检查组件母版");
  if (outputImages.some((image) => !image) || outputText.some((text) => text === undefined)) throw new LayoutError("有内容未完成填写");
  const native = options.native ? partitionNativeArticle(root as HTMLElement, [...(pageBody?.children ?? [])]) : undefined;
  if (options.editing) { copyEditingBindings(root, clean.content.firstElementChild!); return { html: clean.innerHTML, plan, instanceCount, native }; }
  return { html, plan, instanceCount, native };
}

export function explainLayoutError(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) return error.issues.slice(0, 3).map((issue: { path?: (string | number)[]; message?: string }) => `${issue.path?.join(".") || "模板"}：${issue.message}`).join("；");
  return error instanceof Error ? error.message : "排版未完成，请检查输入与模板";
}
