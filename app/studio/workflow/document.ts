import type { CompatibilityIssue, StudioProject } from "../types";
import { adaptLegacyArticle } from "../template-engine";
import { captureBaseline } from "../submission/baseline";
import { emptySubmission } from "../submission/ingest";
import { submissionBlockers } from "../submission/assemble";
import { templateContentBlockers } from "../local-template-fill";
import { renderProject, verifyHtml } from "../renderer";
import type { Workflow } from "./types";

export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
// Content revision checksum, not an identity credential or authentication signature.
export function revision(value: unknown): string {
  const text = canonical(value); let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (let i = 0; i < text.length; i++) { const n = text.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b ^ n, 2246822507); c = Math.imul(c ^ n, 3266489909); d = Math.imul(d ^ n, 668265263); }
  return [a, b, c, d].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}
export function workingNodes(project: StudioProject) {
  if (project.mode === "clone" && project.cloneTemplate) return captureBaseline(emptySubmission("update"), project).base_draft!;
  const nodes = (project.layout?.article ?? adaptLegacyArticle(project.content, project.id)).nodes;
  const refs = project.submission?.draft?.nodes ?? project.submission?.base_draft ?? [];
  return nodes.map((node) => refs.find((ref) => ref.id === node.id && ref.type === "image_ref") ?? node);
}
export const layoutRevision = (p: StudioProject) => revision(p.mode === "clone" ? [p.cloneTemplate?.analyzedHtml, p.cloneTemplate?.modules, p.cloneTemplate?.slots.map((s) => [s.id, s.role, s.prefix, s.suffix])] : p.layout ? [p.layout.template, p.layout.overrides, p.layout.presetId, p.layout.nodeVariants, p.layout.article.nodes.flatMap((n) => n.type === "image" ? [[n.id, n.group]] : [])] : [p.theme, p.density, p.accentOverride]);
export function projectRevision(project: StudioProject) { return revision([project.mode, workingNodes(project), layoutRevision(project), renderProject(project), project.submission && [project.submission.pending, project.submission.publishing, project.submission.files, project.submission.documents, project.submission.assets, project.submission.user_instructions, project.submission.main_document_ids, project.submission.decisions], project.cloneTemplate?.unplacedContent, project.cloneTemplate?.pendingAssets, project.cloneTemplate?.excludedContent]); }
export function ensureWorkflow(project: StudioProject): Workflow { return project.workflow ?? { schema: "opslion/workflow/v1", basis: structuredClone(workingNodes(project)), edits: [], decisions: [] }; }
export function recordEdit(previous: StudioProject, next: StudioProject, origin: "human" | "rule" | "model" = "human"): StudioProject {
  if (previous.id !== next.id) return next;
  if (previous.layout === next.layout && previous.cloneTemplate === next.cloneTemplate && previous.content === next.content && previous.mode === next.mode && previous.theme === next.theme && previous.density === next.density && previous.accentOverride === next.accentOverride && previous.submission === next.submission) return next;
  try {
    const before = workingNodes(previous), after = workingNodes(next);
    const added = after.filter((n) => !before.some((b) => b.id === n.id)).map((n) => n.id);
    const deleted = before.filter((n) => !after.some((b) => b.id === n.id)).map((n) => n.id);
    const commonBefore = before.filter((n) => after.some((b) => b.id === n.id)).map((n) => n.id);
    const commonAfter = after.filter((n) => before.some((b) => b.id === n.id)).map((n) => n.id);
    const changed = after.filter((n) => { const old = before.find((b) => b.id === n.id); return old && (canonical(old) !== canonical(n) || commonBefore.indexOf(n.id) !== commonAfter.indexOf(n.id)); }).map((n) => n.id);
    const layoutChanged = layoutRevision(previous) !== layoutRevision(next);
    if (!added.length && !deleted.length && !changed.length && !layoutChanged) return next;
    const workflow = next.workflow ?? ensureWorkflow(previous);
    let decisions = [...workflow.decisions];
    if (origin === "human" && next.layout) {
      for (const [nodeId, componentId] of Object.entries(next.layout.nodeVariants ?? {})) if (previous.layout?.nodeVariants?.[nodeId] !== componentId) decisions = [...decisions.filter((d) => d.decision.kind !== "component_variant" || d.decision.nodeId !== nodeId), { decision: { kind: "component_variant", nodeId, componentId, requirementIds: [] }, origin: "human", locked: true }];
      for (const node of next.layout.article.nodes) if (node.type === "image" && node.group && previous.layout?.article.nodes.filter((n) => n.type === "image").find((n) => n.id === node.id)?.group !== node.group) {
        const nodeIds = next.layout.article.nodes.filter((n) => n.type === "image" && n.group === node.group).map((n) => n.id);
        if (nodeIds.length <= 3) decisions = [...decisions.filter((d) => d.decision.kind !== "image_group" || !d.decision.nodeIds.some((id) => nodeIds.includes(id))), { decision: { kind: "image_group", nodeIds, requirementIds: [] }, origin: "human", locked: true }];
      }
    }
    return { ...next, workflow: { ...workflow, decisions: decisions.slice(-1000), edits: [...workflow.edits.slice(-199), { id: crypto.randomUUID(), origin, changed, added, deleted, layoutChanged, at: new Date().toISOString() }] } };
  } catch { return next; } // Existing rendering errors stay visible; editing and backups remain available.
}
export function contentBlockers(project: StudioProject): string[] {
  try { return [...submissionBlockers(project.submission ?? undefined), ...(project.mode === "clone" ? templateContentBlockers(project.cloneTemplate) : []), ...verifyHtml(renderProject(project)).filter((i) => i.level === "error").map((i) => i.detail), ...(!renderProject(project).trim() ? ["当前稿件没有可交付内容"] : [])]; }
  catch (error) { return [error instanceof Error ? error.message : "当前稿件无法编译"]; }
}
export function layoutCompletion(project: StudioProject, issues?: CompatibilityIssue[]) {
  const blockers = issues ? issues.filter((issue) => issue.level === "error").map((issue) => issue.detail) : contentBlockers(project);
  if (blockers.length) return `自动排版还需处理 ${blockers.length} 项：${blockers[0]}`;
  return (issues ?? verifyHtml(renderProject(project))).some((issue) => issue.level === "warning") || project.mode === "clone" && project.cloneTemplate?.draftWarnings?.length
    ? "自动排版已完成，内容完整；请查看排版提示"
    : "自动排版已完成，内容与基础兼容性检查通过";
}
