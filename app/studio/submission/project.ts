import type { StudioProject } from "../types";
import type { Submission } from "./types";
import { articleToLegacyContent, plainLayout, compileArticle, createLayoutState } from "../template-engine";
import { projectDraft } from "./assemble";
import { applyNativeDraft } from "./baseline";
import { fillArticleTemplate } from "../local-template-fill";

export const submissionTemplateName = (project: StudioProject) => project.mode === "clone" ? project.cloneTemplate?.name || "尚未选择历史模板" : project.layout?.template.name || plainLayout.name;
export function commitSubmission(current: StudioProject, submission: Submission): StudioProject {
  if (!submission.applied && submission.mode === "update" && submission.base_draft && submission.base_article_id === current.id) {
    const working = { ...submission, applied: true, draft: { id: current.id, nodes: submission.base_draft } };
    const result = commitSubmission(current, working);
    return { ...result, submission: { ...submission, base_article: projectDraft(working) } };
  }
  if (!submission.applied || !submission.draft) return { ...current, submission };
  if (submission.native_bindings && current.cloneTemplate) {
    const template = applyNativeDraft(current.cloneTemplate, submission);
    template.pendingAssets = template.pendingAssets?.filter((asset) => submission.draft!.nodes.some((node) => node.id === asset.id) || !(current.submission?.draft?.nodes ?? current.submission?.base_draft)?.some((node) => node.id === asset.id)).map((asset) => { const node = submission.draft!.nodes.find((n) => n.id === asset.id); return node?.type === "image" ? { ...asset, imageUrl: node.src } : asset; });
    return { ...current, submission, mode: "clone", cloneTemplate: template };
  }
  const article = projectDraft(submission);
  if (current.mode === "clone") {
    if (!current.cloneTemplate) throw new Error("请先选择历史模板；交稿将使用这里显示的模板");
    const filled = fillArticleTemplate(article, current.cloneTemplate, submission.draft.nodes);
    return { ...current, content: articleToLegacyContent(article), cloneTemplate: filled.state, submission: { ...submission, native_bindings: filled.native_bindings, base_article: article } };
  }
  const layout = current.layout ? { ...current.layout, article } : createLayoutState(article, plainLayout);
  compileArticle(article, layout.template, layout.presetId, layout.overrides, { nodeVariants: layout.nodeVariants });
  return { ...current, submission, layout, content: articleToLegacyContent(article) };
}
