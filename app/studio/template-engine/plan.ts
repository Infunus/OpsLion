import { structureArticle, entryNode, isSection, type Entry } from "./structure";
import { LayoutError } from "./validate";
import type { ArticleNode, FieldSource, FieldValue, LayoutPlan, Mapping, ParsedArticle, PlanInstance, SemanticContext, TemplateDefinition } from "./types";

export function imageGroupSizes(count: number, strategy: "balanced-2-3" | "greedy-3"): number[] {
  const groups: number[] = [];
  while (count > 0) {
    const size = strategy === "balanced-2-3" && count === 4 ? 2 : Math.min(count, 3);
    groups.push(size); count -= size;
  }
  return groups;
}
export function allowedNodeVariants(mapping: Mapping): string[] { return [...new Set([mapping.component, ...(mapping.allowedVariants ?? []), ...(mapping.selection?.kind === "cycle" ? mapping.selection.components : mapping.selection?.variants.map((item) => item.component) ?? [])])]; }
export function planArticle(article: ParsedArticle, template: TemplateDefinition, tokens: Record<string, string | number>, nodeVariants: Record<string, string> = {}): LayoutPlan {
  const { root, contexts } = structureArticle(article);
  const nodeById = new Map(article.nodes.map((node) => [node.id, node]));
  const counters = new Map<string, Record<string, string>>();
  for (const [name, rule] of Object.entries(template.rules.counters)) {
    const counts = new Map<string, number>();
    for (const node of article.nodes) if (node.type === rule.type) {
      const context = contexts.get(node.id)!;
      const ancestor = rule.scope === "article" ? undefined : [...context.ancestors].reverse().find((id) => nodeById.get(id)?.type === rule.scope);
      const scope = ancestor === undefined ? "article" : `section:${ancestor}`;
      const count = counts.get(scope) ?? rule.start; counts.set(scope, count + 1);
      counters.set(node.id, { ...counters.get(node.id), [name]: String(count).padStart(rule.pad, "0") });
    }
  }
  type Data = ArticleNode | { id: string; content: Extract<FieldValue, unknown[]> } | null;
  const values = (sources: Record<string, FieldSource>, data: Data): Record<string, FieldValue> => Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    if ("literal" in source) return [name, source.literal];
    if ("counter" in source) return [name, data ? counters.get(data.id)?.[source.counter] : undefined];
    const value = source.from === "self" ? data : data && source.from in data ? data[source.from as keyof typeof data] : undefined;
    return [name, value as FieldValue];
  }));
  const instance = (component: string, path: string, fields: Record<string, FieldValue> = {}, primarySources: string[] = []): PlanInstance => ({ id: `${article.id}/${path}`, component, role: template.components[component].role, fields, primarySources, regions: {}, gap: 0 });
  const choose = (mapping: Mapping, context: SemanticContext) => {
    const rule = mapping.selection;
    if (rule?.kind === "cycle") return rule.components[((rule.scope === "article" ? context.typeIndexInArticle : context.typeIndexInSection) - 1) % rule.components.length];
    if (rule?.kind === "first-match") for (const variant of rule.variants) {
      if (Object.entries(variant.when).every(([key, expected]) => key === "lastInFlow" ? (context.indexInFlow === context.flowLength) === expected : context[key as keyof SemanticContext] === expected)) return variant.component;
    }
    return mapping.component;
  };
  const repeat = (parent: PlanInstance, name: string, items: Exclude<Data, null>[]) => {
    const region = template.components[parent.component].regions[name];
    if (region.kind !== "repeat") throw new LayoutError(`${parent.component}.${name} 不是重复区域`);
    parent.regions[name] = items.map((item) => instance(region.itemComponent, `${parent.id}/items/${encodeURIComponent(item.id)}`, values(region.fields, item), [item.id]));
  };
  const nodeInstance = (node: ArticleNode) => {
    const mapping = template.mapping[node.type]!;
    const selected = nodeVariants[node.id] ?? choose(mapping, contexts.get(node.id)!);
    if (!allowedNodeVariants(mapping).includes(selected)) throw new LayoutError(`此模板未允许 ${node.id} 使用组件 ${selected}`);
    const result = instance(selected, `node/${encodeURIComponent(node.id)}`, values(mapping.fields, node), [node.id]);
    for (const name of Object.keys(mapping.regions)) if ("items" in node) repeat(result, name, node.items);
    return result;
  };
  const gap = (value: TemplateDefinition["rules"]["spacing"]["default"]) => typeof value === "number" ? value : Number(tokens[value.token]);
  const space = (items: PlanInstance[]) => { items.forEach((item, index) => { item.gap = index ? gap(template.rules.spacing.pairs[`${items[index - 1].role}>${item.role}`] ?? template.rules.spacing.default) : 0; }); return items; };
  const decorations = (position: "article-start" | "article-end" | "between-sections", path: string, level?: string) => template.rules.decorations.flatMap((rule, index) => rule.position === position && (position !== "between-sections" || rule.level === level) ? [instance(rule.component, `decoration/${path}/${index}`, values(rule.fields, null))] : []);
  const flow = (entries: Entry[], path: string): PlanInstance[] => {
    const result: PlanInstance[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]; const node = entryNode(entry);
      const previous = entries[index - 1];
      if (isSection(entry)) {
        if (previous && isSection(previous) && previous.heading.type === node.type) result.push(...decorations("between-sections", node.id, node.type));
        const heading = nodeInstance(node); const body = flow(entry.children, node.id);
        const wrapper = template.rules.sections[entry.heading.type];
        if (wrapper) {
          const card = instance(wrapper.wrapper, `section/${encodeURIComponent(node.id)}`);
          card.regions[wrapper.headingRegion] = [heading]; card.regions[wrapper.bodyRegion] = body; result.push(card);
        } else result.push(heading, ...body);
      } else if (node.type === "image" && template.rules.sequences.images) {
        const images: ArticleNode[] = [node];
        while (entries[index + 1] && !isSection(entries[index + 1])) {
          const next = entryNode(entries[index + 1]);
          if (next.type !== "image" || next.group !== node.group || nodeVariants[next.id] || nodeVariants[node.id]) break;
          images.push(next); index++;
        }
        const rule = template.rules.sequences.images; let offset = 0;
        for (const size of imageGroupSizes(images.length, rule.strategy)) {
          const group = images.slice(offset, offset + size); offset += size;
          if (size === 1) result.push(nodeInstance(group[0]));
          else { const parent = instance(size === 2 ? rule.pair : rule.triple, `images/${encodeURIComponent(group[0].id)}`); repeat(parent, "items", group); result.push(parent); }
        }
      } else result.push(nodeInstance(node));
    }
    if (path === "root") result.unshift(...decorations("article-start", "root"));
    if (path === "root") result.push(...decorations("article-end", "root"));
    return space(result);
  };
  const page = instance(template.page.component, "page"); page.regions[template.page.bodyRegion] = flow(root, "root");
  const sourceOrder = article.nodes.flatMap((node) => [node.id, ...("items" in node ? node.items.map((item) => item.id) : [])]);
  const actual: string[] = [];
  const audit = (item: PlanInstance) => { actual.push(...item.primarySources); Object.values(item.regions).forEach((children) => children.forEach(audit)); };
  audit(page);
  if (JSON.stringify(actual) !== JSON.stringify(sourceOrder)) throw new LayoutError("排版结果的内容顺序或数量与输入不一致");
  return { articleId: article.id, templateId: template.id, version: template.version, page, sourceOrder };
}
