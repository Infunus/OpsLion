import type { StudioProject } from "../types";
import { allowedNodeVariants, compileArticle, richTextToPlain, resolveTemplate } from "../template-engine";
import { layoutDecisionSetSchema } from "./types";
import { canonical, ensureWorkflow, projectRevision } from "./document";
import { syncDraftEdits } from "../submission/assemble";

export function layoutRequest(project: StudioProject) {
  if (project.mode !== "compose" || !project.layout) throw new Error("基础槽位模板已在本地排版；需要改动时使用逐项编辑或高级模板操作。");
  const layout = project.layout;
  const template = resolveTemplate(layout.template);
  compileArticle(layout.article, layout.template, layout.presetId, layout.overrides, { nodeVariants: layout.nodeVariants });
  return { task: "plan_layout", schema: "opslion/layout-request/v1", baseRevision: projectRevision(project),
    template: { id: layout.template.id, version: layout.template.version, name: layout.template.name, imageGroups: Boolean(layout.template.rules.sequences.images) },
    nodes: layout.article.nodes.map((node) => ({ id: node.id, type: node.type, text: "content" in node ? richTextToPlain(node.content) : "items" in node ? node.items.map((i) => richTextToPlain(i.content)).join("\n") : "caption" in node ? richTextToPlain(node.caption ?? []) : "", components: template.mapping[node.type] ? allowedNodeVariants(template.mapping[node.type]!) : [], currentComponent: layout.nodeVariants?.[node.id], group: node.type === "image" ? node.group : undefined,
      componentLocked: Boolean(layout.nodeVariants?.[node.id] && !project.workflow?.decisions.some((d) => d.origin === "model" && !d.locked && d.decision.kind === "component_variant" && d.decision.nodeId === node.id && d.decision.componentId === layout.nodeVariants?.[node.id])),
      groupLocked: node.type === "image" && Boolean(node.group) && !project.workflow?.decisions.some((d) => d.origin === "model" && !d.locked && d.decision.kind === "image_group" && d.decision.nodeIds.includes(node.id)) })),
    requirements: project.submission?.pending.filter((p) => p.kind === "layout_preference").map((p) => ({ id: p.id, text: p.message })) ?? [],
    observation: { kind: "structural", compiled: true, visualReview: "not-run" },
  };
}
export function applyLayoutDecisions(project: StudioProject, raw: unknown): StudioProject {
  const plan = layoutDecisionSetSchema.parse(raw); const request = layoutRequest(project);
  if (plan.baseRevision !== request.baseRevision) throw new Error("稿件、模板或素材已变动，增强结果未应用");
  const layout = structuredClone(project.layout!); const used = new Set<string>(), resolved = new Set<string>();
  for (const decision of plan.decisions) {
    const ids = decision.kind === "component_variant" ? [decision.nodeId] : decision.nodeIds;
    if (new Set(ids).size !== ids.length) throw new Error("图片组合重复引用同一位置");
    for (const id of ids) {
      const node = request.nodes.find((n) => n.id === id); const key = `${decision.kind}:${id}`;
      if (!node || used.has(key)) throw new Error("版式决策引用未知或重复位置"); used.add(key);
      if (decision.kind === "component_variant" && (node.componentLocked || !node.components.includes(decision.componentId))) throw new Error("AI 不能覆盖人工组件选择或使用未知组件");
      if (decision.kind === "image_group" && (node.type !== "image" || node.groupLocked)) throw new Error("AI 不能覆盖人工图片组合或组合非图片内容");
    }
    for (const id of decision.requirementIds) { if (!request.requirements.some((r) => r.id === id)) throw new Error("AI 不能关闭内容待办或未知要求"); resolved.add(id); }
    if (decision.kind === "component_variant") layout.nodeVariants = { ...layout.nodeVariants, [decision.nodeId]: decision.componentId };
    else {
      if (ids.length > 1 && !request.template.imageGroups) throw new Error("模板不支持并排图片");
      const start = layout.article.nodes.findIndex((n) => n.id === ids[0]);
      if (canonical(layout.article.nodes.slice(start, start + ids.length).map((n) => n.id)) !== canonical(ids)) throw new Error("图片组合必须保持相邻位置和阅读顺序");
      layout.article.nodes = layout.article.nodes.map((n) => n.type === "image" && ids.includes(n.id) ? { ...n, group: `decision:${plan.baseRevision}:${ids.join(":")}` } : n);
    }
  }
  if (plan.unresolved.some((u) => !request.requirements.some((r) => r.id === u.id) || resolved.has(u.id))) throw new Error("未解决要求与实际决策矛盾");
  compileArticle(layout.article, layout.template, layout.presetId, layout.overrides, { nodeVariants: layout.nodeVariants });
  const workflow = ensureWorkflow(project);
  return { ...project, layout, workflow: { ...workflow, decisions: [...workflow.decisions.filter((old) => !plan.decisions.some((d) => d.kind === old.decision.kind && (d.kind === "component_variant" && old.decision.kind === "component_variant" ? d.nodeId === old.decision.nodeId : d.kind === "image_group" && old.decision.kind === "image_group" && d.nodeIds.some((id) => old.decision.kind === "image_group" && old.decision.nodeIds.includes(id))))), ...plan.decisions.map((decision) => ({ decision, origin: "model" as const, locked: false }))].slice(-1000) },
    ...(project.submission ? { submission: { ...syncDraftEdits(project.submission, layout.article), pending: project.submission.pending.filter((p) => !resolved.has(p.id)), decisions: [...project.submission.decisions, ...[...resolved].map((id) => ({ id, resolution: `AI 版式选择已应用：${request.requirements.find((r) => r.id === id)!.text}` }))] } } : {}) };
}
