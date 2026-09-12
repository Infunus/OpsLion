import { sanitizeArticleHtml } from "../html-policy";
import { basicComponents, basicMapping, basicTokens } from "./basic-components";
import { cleanPageFormat } from "../page-format";
import { contentFieldTarget } from "./field-target";
import { nodeKinds, templateDefinitionSchema, type ComponentDefinition, type FieldSource, type Mapping, type TemplateDefinition, type Token } from "./types";

export class LayoutError extends Error { constructor(message: string) { super(message); this.name = "LayoutError"; } }
function fail(message: string): never { throw new LayoutError(message); }
export function resolveTemplate(input: unknown): TemplateDefinition {
  const template = templateDefinitionSchema.parse(input);
  const resolved: TemplateDefinition = { ...template, base: null, components: { ...(template.base ? basicComponents : {}), ...template.components }, mapping: { ...(template.base ? basicMapping : {}), ...template.mapping }, tokens: { ...(template.base ? basicTokens : {}), ...template.tokens } };
  if (template.pageFormat) {
    resolved.pageFormat = cleanPageFormat(template.pageFormat);
    // The base body's explicit defaults should inherit the captured page format.
    // Authored tokens, presets and per-project overrides retain priority.
    if (template.base) {
      const styles = resolved.pageFormat.styles;
      const color = (value?: string) => { if (!value) return undefined; const context = document.createElement("canvas").getContext("2d"); if (!context) return undefined; context.fillStyle = value; return /^#[a-f\d]{6}$/i.test(context.fillStyle) ? context.fillStyle : undefined; };
      const defaults: Record<string, string | number | undefined> = { text: color(styles.color), paper: color(styles["background-color"]), bodySize: styles["font-size"]?.endsWith("px") ? parseFloat(styles["font-size"]) : undefined, bodyLineHeight: styles["line-height"] && styles["font-size"] && styles["line-height"].endsWith("px") ? parseFloat(styles["line-height"]) / parseFloat(styles["font-size"]) : styles["line-height"] && /^\d*\.?\d+$/.test(styles["line-height"]) ? Number(styles["line-height"]) : undefined };
      for (const [name, value] of Object.entries(defaults)) if (value !== undefined && !template.tokens[name]) resolved.tokens[name] = { ...resolved.tokens[name], value } as Token;
    }
  }
  const component = (id: string) => resolved.components[id] ?? fail(`组件 ${id} 不存在`);
  const source = (value: FieldSource, where: string) => { if ("counter" in value && !resolved.rules.counters[value.counter]) fail(`${where} 引用了不存在的编号 ${value.counter}`); };
  const bindings = (id: string, values: Record<string, FieldSource>, where: string) => {
    const target = component(id);
    for (const [name, field] of Object.entries(target.fields)) if (field.required && !Object.hasOwn(values, name)) fail(`${where} 缺少字段 ${name}`);
    for (const [name, value] of Object.entries(values)) { if (!Object.hasOwn(target.fields, name)) fail(`${where} 未声明字段 ${name}`); source(value, where); }
  };
  for (const [name, token] of Object.entries(resolved.tokens)) validateToken(token, token.value, name);
  if (new Set(resolved.presets.map((preset) => preset.id)).size !== resolved.presets.length) fail("配色方案 ID 重复");
  for (const preset of resolved.presets) resolveTokens(resolved, preset.id);
  for (const [id, definition] of Object.entries(resolved.components)) {
    for (const parameter of Object.values(definition.parameters)) if (!resolved.tokens[parameter.token]) fail(`${id} 引用了不存在的参数 ${parameter.token}`);
    for (const region of Object.values(definition.regions)) if (region.kind === "repeat") bindings(region.itemComponent, region.fields, `${id} 的重复区域`);
  }
  const visited = new Set<string>(); const active = new Set<string>();
  const visit = (id: string) => { if (active.has(id)) fail(`重复区域存在循环引用：${id}`); if (visited.has(id)) return; active.add(id); Object.values(component(id).regions).forEach((region) => { if (region.kind === "repeat") visit(region.itemComponent); }); active.delete(id); visited.add(id); };
  Object.keys(resolved.components).forEach(visit);
  const emptyFields = (id: string) => { if (Object.values(component(id).fields).some((field) => field.required)) fail(`容器 ${id} 不能要求独立内容字段`); };
  const flow = (id: string, region: string) => { if (component(id).regions[region]?.kind !== "flow") fail(`${id}.${region} 不是 flow 区域`); };
  emptyFields(resolved.page.component); flow(resolved.page.component, resolved.page.bodyRegion);
  if (Object.keys(component(resolved.page.component).regions).length !== 1) fail("文章外壳只能声明一个主内容区域");
  for (const wrapper of Object.values(resolved.rules.sections)) {
    if (!wrapper) continue;
    emptyFields(wrapper.wrapper); flow(wrapper.wrapper, wrapper.headingRegion); flow(wrapper.wrapper, wrapper.bodyRegion);
    if (wrapper.headingRegion === wrapper.bodyRegion || Object.keys(component(wrapper.wrapper).regions).length !== 2) fail("章节容器需要两个独立的标题和正文区域");
  }
  for (const kind of nodeKinds) {
    const rule = resolved.mapping[kind] ?? fail(`${kind} 没有语义映射`);
    bindings(rule.component, rule.fields, kind);
    const target = component(rule.component);
    for (const [name, region] of Object.entries(target.regions)) {
      if (!rule.regions[name] || region.kind !== "repeat" || !["ul", "ol"].includes(kind)) fail(`${kind}.${name} 需要列表集合来源`);
      const item = component(region.itemComponent);
      if (Object.keys(item.regions).length || !Object.entries(region.fields).some(([name, source]) => "from" in source && source.from === "content" && item.fields[name].kind === "richtext")) fail(`${kind} 的列表项必须保留原始富文本内容`);
    }
    for (const name of Object.keys(rule.regions)) if (!target.regions[name]) fail(`${kind} 引用了未知区域 ${name}`);
    for (const value of Object.values(rule.fields)) {
      if ("counter" in value && resolved.rules.counters[value.counter].type !== kind) fail(`${kind} 使用了其他标题级别的编号`);
      if ("from" in value && ((value.from === "caption" && kind !== "image") || (value.from === "start" && kind !== "ol") || (value.from === "content" && ["image", "ul", "ol", "divider"].includes(kind)))) fail(`${kind} 不提供 ${value.from} 字段`);
    }
    if (!["image", "ul", "ol", "divider"].includes(kind) && !Object.entries(rule.fields).some(([name, value]) => "from" in value && value.from === "content" && target.fields[name].kind === "richtext")) fail(`${kind} 必须保留原始富文本内容`);
    if (kind === "image" && (!Object.entries(rule.fields).some(([name, value]) => "from" in value && value.from === "self" && target.fields[name].kind === "image") || !Object.entries(rule.fields).some(([name, value]) => "from" in value && value.from === "caption" && target.fields[name].kind === "richtext"))) fail("图片映射必须保留图片和图注");
    if (kind === "ol" && !Object.entries(rule.fields).some(([name, source]) => "from" in source && source.from === "start" && target.fields[name].bindings.some((binding) => binding.type === "attribute" && binding.name === "start"))) fail("有序列表必须绑定起始序号");
    const variants = rule.selection?.kind === "cycle" ? rule.selection.components : rule.selection?.variants.map((variant) => variant.component) ?? [];
    for (const variant of [...variants, ...(rule.allowedVariants ?? [])]) if (componentInterface(component(variant)) !== componentInterface(target)) fail(`${variant} 与 ${rule.component} 的字段或区域接口不一致`);
  }
  const group = resolved.rules.sequences.images;
  if (group) for (const id of [group.pair, group.triple]) {
    const target = component(id); emptyFields(id);
    if (Object.keys(target.regions).length !== 1 || target.regions.items?.kind !== "repeat") fail(`${id} 需要唯一的 items 重复区域`);
    const fields = target.regions.items.fields;
    const cell = component(target.regions.items.itemComponent);
    if (Object.keys(cell.regions).length || !Object.entries(fields).some(([name, value]) => "from" in value && value.from === "self" && cell.fields[name].kind === "image")) fail(`${id} 必须传递每张图片`);
    if (!Object.entries(fields).some(([name, value]) => "from" in value && value.from === "caption" && cell.fields[name].kind === "richtext")) fail(`${id} 必须保留每张图片的图注`);
  }
  for (const counter of Object.values(resolved.rules.counters)) if (counter.scope !== "article" && Number(counter.scope.slice(-1)) >= Number(counter.type.slice(-1))) fail("编号的重置范围必须是上级章节");
  for (const decoration of resolved.rules.decorations) {
    bindings(decoration.component, decoration.fields, "装饰");
    if (Object.keys(component(decoration.component).regions).length || Object.values(decoration.fields).some((value) => !("literal" in value))) fail("装饰只接受固定字段，不接收正文区域");
    if (decoration.position === "between-sections" && !decoration.level) fail("章节间装饰需要指定标题级别");
  }
  for (const value of [resolved.rules.spacing.default, ...Object.values(resolved.rules.spacing.pairs)]) if (typeof value !== "number" && resolved.tokens[value.token]?.kind !== "length") fail("间距需要长度类型的参数");
  return resolved;
}
function componentInterface(component: ComponentDefinition) {
  return JSON.stringify({ fields: Object.entries(component.fields).map(([name, field]) => [name, field.kind, field.required]).sort(), regions: Object.entries(component.regions).map(([name, region]) => [name, region.kind]).sort() });
}
function validateToken(token: Token | undefined, value: string | number, name: string) {
  if (!token) fail(`不存在参数 ${name}`);
  if (token.kind === "color") { if (typeof value !== "string" || !/^#[a-f\d]{6}$/i.test(value)) fail(`${token.label} 需要六位十六进制颜色`); }
  else if (typeof value !== "number" || !Number.isFinite(value) || value < token.min || value > token.max || token.min > token.max) fail(`${token.label} 需要介于 ${token.min} 和 ${token.max} 之间`);
}
export function resolveTokens(template: TemplateDefinition, presetId: string | null = null, overrides: Record<string, string | number> = {}) {
  const values = Object.fromEntries(Object.entries(template.tokens).map(([name, token]) => [name, token.value]));
  const preset = presetId ? template.presets.find((item) => item.id === presetId) ?? fail(`配色方案 ${presetId} 不存在`) : null;
  for (const [name, value] of Object.entries(preset?.values ?? {})) { validateToken(template.tokens[name], value, name); values[name] = value; }
  for (const [name, value] of Object.entries(overrides)) { validateToken(template.tokens[name], value, name); if (!template.tokens[name].editable) fail(`${name} 未开放编辑`); values[name] = value; }
  return values;
}

/** Reuse the article policy without making authoring markers trusted on every import. */
export function prepareComponent(definition: ComponentDefinition, assets: Record<string, string>, id: string): string {
  const holder = document.createElement("template"); holder.innerHTML = definition.source.html;
  const root = holder.content.firstElementChild;
  if (!root || holder.content.children.length !== 1 || [...holder.content.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) fail(`${id} 需要唯一的 HTML 布局根`);
  if ([root, ...root.querySelectorAll("*")].some((element) => /^(script|style|iframe|form|input|object|embed)$/i.test(element.tagName) || [...element.attributes].some((attribute) => /^on/i.test(attribute.name)))) fail(`${id} 的母版包含不支持的活动内容`);
  const parts = new Map<string, Element>();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const part = element.getAttribute("data-layout-part");
    if (part) { if (parts.has(part)) fail(`${id} 的部件 ${part} 重复`); parts.set(part, element); }
    for (const attribute of [...element.attributes]) if (attribute.name.startsWith("data-layout-")) element.removeAttribute(attribute.name);
    if (part) element.setAttribute("data-layout-slot", part);
  }
  // Fixed assets are resolved from the original tree before the policy removes markers.
  const original = document.createElement("template"); original.innerHTML = definition.source.html;
  const originalElements = [...original.content.querySelectorAll("*")];
  [root, ...root.querySelectorAll("*")].forEach((element, index) => {
    const asset = originalElements[index]?.getAttribute("data-layout-asset");
    if (asset) { if (element.tagName !== "IMG" || !assets[asset]) fail(`${id} 的固定素材 ${asset} 无法解析`); element.setAttribute("src", assets[asset]); }
    const background = originalElements[index]?.getAttribute("data-layout-background");
    if (background) { if (!assets[background]) fail(`${id} 的背景素材 ${background} 无法解析`); (element as HTMLElement).style.backgroundImage = `url("${assets[background].replace(/"/g, "%22")}")`; }
  });
  if (parts.get(definition.layoutPart) !== root) fail(`${id}.layoutPart 必须指向母版根元素`);
  const cleaned = document.createElement("template"); cleaned.innerHTML = sanitizeArticleHtml(holder.innerHTML);
  const cleanParts = new Map([...cleaned.content.querySelectorAll("[data-layout-slot]")].map((element) => [element.getAttribute("data-layout-slot")!, element]));
  if (cleanParts.size !== parts.size || [...parts].some(([part, element]) => cleanParts.get(part)?.tagName !== element.tagName)) fail(`${id} 的必要部件无法通过 HTML 清理`);
  const lookup = (part: string) => cleanParts.get(part) ?? fail(`${id} 缺少部件 ${part}`);
  const owners = new Map<string, string>(); const contentTargets: Element[] = [];
  const own = (part: string, target: string, owner: string) => { const key = `${part}:${target}`; if (owners.has(key)) fail(`${id}.${part} 存在重复绑定：${owners.get(key)}、${owner}`); owners.set(key, owner); };
  for (const [name, field] of Object.entries(definition.fields)) for (const binding of field.bindings) {
    const element = lookup(binding.part);
    if (binding.type !== "attribute" && binding.type !== field.kind) fail(`${id}.${name} 的字段类型与绑定不匹配`);
    if (binding.type === "attribute" && !["number", "text"].includes(field.kind)) fail(`${id}.${name} 不能写入标量属性`);
    if (binding.type === "image" && element.tagName !== "IMG") fail(`${id}.${name} 需要 img 部件`);
    if (binding.type === "attribute" && binding.name === "start" && element.tagName !== "OL") fail(`${id}.${name} 的起始序号只能绑定 ol`);
    own(binding.part, binding.type === "attribute" ? `@${binding.name}` : "content", name);
    if (binding.type === "text" || binding.type === "richtext") {
      try { contentTargets.push(contentFieldTarget(element, binding.mode)); } catch (error) { fail(`${id}.${name}：${(error as Error).message}`); }
    }
  }
  for (const [name, region] of Object.entries(definition.regions)) { const element = lookup(region.part); own(region.part, "content", name); contentTargets.push(element); }
  for (const element of contentTargets) {
    if (contentTargets.some((other) => other !== element && element.contains(other))) fail(`${id} 的内容部件不能互相覆盖`);
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      if (parent.namespaceURI === "http://www.w3.org/2000/svg") fail(`${id} 的可变内容不能放在固定 SVG 画布中，请把 SVG 作为字段外的装饰`);
      const style = (parent as HTMLElement).style;
      if ((style.height && style.height !== "auto") || (style.maxHeight && style.maxHeight !== "none") || /hidden|clip/.test(style.overflow + style.overflowY) || style.whiteSpace === "nowrap" || style.display === "none" || ["absolute", "fixed", "sticky"].includes(style.position) || (style.cssFloat && style.cssFloat !== "none")) fail(`${id} 的可变内容需要自然高度和换行`);
    }
  }
  for (const [name, parameter] of Object.entries(definition.parameters)) for (const binding of parameter.bindings) {
    const element = lookup(binding.part); own(binding.part, `style:${binding.name}`, name);
    if (contentTargets.some((target) => element.contains(target)) && /^(height|max-height|overflow|overflow-y|display|white-space|opacity|visibility)$/.test(binding.name)) fail(`${id} 的参数不能隐藏或限制可变内容`);
  }
  const layout = lookup(definition.layoutPart) as HTMLElement;
  if ([layout.style.marginTop, layout.style.marginBottom].some((value) => value && value !== "0px")) fail(`${id} 的布局根上下 margin 需要归零`);
  for (const [part, element] of cleanParts) { element.removeAttribute("data-layout-slot"); element.setAttribute("data-layout-part", part); }
  return cleaned.innerHTML;
}

const prepared = new Map<string, TemplateDefinition>();
export function publishTemplate(input: unknown): TemplateDefinition {
  const cacheKey = JSON.stringify(input); const cached = prepared.get(cacheKey);
  if (cached) return structuredClone(cached);
  const template = resolveTemplate(input);
  template.components = Object.fromEntries(Object.entries(template.components).map(([id, component]) => [id, { ...component, source: { kind: "markup", html: prepareComponent(component, template.assets, id) } }]));
  for (const wrapper of Object.values(template.rules.sections)) {
    if (!wrapper) continue;
    const component = template.components[wrapper.wrapper]; const holder = document.createElement("template"); holder.innerHTML = component.source.html;
    const parts = new Map([...holder.content.querySelectorAll("[data-layout-part]")].map((element) => [element.getAttribute("data-layout-part"), element]));
    const heading = parts.get(component.regions[wrapper.headingRegion].part)!; const body = parts.get(component.regions[wrapper.bodyRegion].part)!;
    if (!(heading.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)) fail(`${wrapper.wrapper} 的标题区域必须位于正文之前`);
  }
  for (const kind of ["ul", "ol"] as const) {
    const mapping = template.mapping[kind]!; const selected = [mapping.component, ...(mapping.selection?.kind === "cycle" ? mapping.selection.components : mapping.selection?.variants.map((item) => item.component) ?? [])];
    for (const name of selected) {
      const component = template.components[name]; const holder = document.createElement("template"); holder.innerHTML = component.source.html;
      for (const region of Object.values(component.regions)) if (region.kind === "repeat") {
        const target = [...holder.content.querySelectorAll("[data-layout-part]")].find((element) => element.getAttribute("data-layout-part") === region.part);
        const item = document.createElement("template"); item.innerHTML = template.components[region.itemComponent].source.html;
        if (target?.tagName !== kind.toUpperCase() || item.content.firstElementChild?.tagName !== "LI") fail(`${kind} 必须保持原生列表与列表项结构`);
      }
    }
  }
  if (prepared.size >= 12) prepared.delete(prepared.keys().next().value!);
  prepared.set(cacheKey, template);
  return structuredClone(template);
}
export function defaultMapping(component: string, fields: Mapping["fields"] = {}): Mapping { return { component, fields, regions: {} }; }
