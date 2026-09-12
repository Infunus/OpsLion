import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { StudioProject } from "../types";
import { makeId } from "../types";
import { commitSubmission } from "../submission/project";
import { renderProject } from "../renderer";
import { requestAgentPlan } from "../agent-client";
import { planLocalSubmission } from "./local-planner";
import { applyLayoutDecisions, layoutRequest } from "./layout-decisions";
import { ensureWorkflow, layoutCompletion, projectRevision } from "./document";
import type { Workflow } from "./types";

export function localCandidate(project: StudioProject, projects: StudioProject[]): StudioProject {
  let next = project;
  if (project.submission) {
    let submission = planLocalSubmission(project.submission);
    if (!project.submission.applied && submission.mode !== "update") {
      const base = submission.mode === "derive" ? [project, ...projects].find((p) => p.id === submission.base_article_id) : project;
      if (!base) throw new Error("派生基准稿已不可用");
      const id = makeId("project");
      next = { ...base, id, workflow: undefined, createdAt: new Date().toISOString(), name: submission.mode === "derive" ? `${base.name}（副本）` : submission.documents.find((d) => submission.main_document_ids.includes(d.id))?.name.replace(/\.(docx|txt|md)$/i, "") || "交稿文章" };
      submission = { ...submission, draft: submission.draft ? { ...submission.draft, id } : undefined };
    }
    next = commitSubmission(next, submission);
  }
  if (!renderProject(next).trim()) throw new Error("请先选择模板并提供文稿");
  return { ...next, workflow: ensureWorkflow(next) };
}

export function useLayoutRun({ project, projects, setProject, ai, flush, checkpoint, showResult, notify }: {
  project: StudioProject; projects: StudioProject[]; ai: boolean;
  setProject: (update: SetStateAction<StudioProject>, origin?: "human" | "rule" | "model") => void;
  flush: () => Promise<unknown>; checkpoint: (reason: string, snapshot?: StudioProject) => Promise<unknown>; showResult: (p: StudioProject) => void; notify: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(project); useEffect(() => { latest.current = project; }, [project]);
  useEffect(() => () => controller.current?.abort(), []);
  const cancel = () => { controller.current?.abort(); controller.current = null; setBusy(false); };
  const run = async () => {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true);
    let candidate: StudioProject | null = null, requestRevision = "";
    const runId = crypto.randomUUID(), mode = ai ? "ai" as const : "local" as const;
    const finish = (status: NonNullable<Workflow["run"]>["status"], message: string, requests: number | null = 0, usage?: unknown) => {
      setProject((current) => current.workflow?.run?.id === runId ? { ...current, workflow: { ...current.workflow, run: { ...current.workflow.run, status, message, inputRevision: projectRevision(current), requests, usage } } } : current, "rule");
      notify(message);
    };
    try {
      const initial = projectRevision(project);
      if (project.workflow?.run?.inputRevision === initial && project.workflow.run.mode === mode && ["local", "enhanced"].includes(project.workflow.run.status)) { showResult(project); notify(layoutCompletion(project)); return; }
      candidate = localCandidate(project, projects);
      await flush();
      if (active.signal.aborted || latest.current.id !== project.id || projectRevision(latest.current) !== initial) throw new Error("文稿或材料已变化，请重新排版");
      if (candidate.id === project.id) await checkpoint("一键排版");
      if (active.signal.aborted || latest.current.id !== project.id || projectRevision(latest.current) !== initial) throw new Error("文稿或材料已变化，请重新排版");
      candidate = { ...candidate, workflow: { ...ensureWorkflow(candidate), run: { id: runId, inputRevision: projectRevision(candidate), mode, status: "local", message: ai ? "正在自动选择模板版式" : layoutCompletion(candidate), visualReview: "not-run", requests: 0 } } };
      setProject(candidate, "rule"); latest.current = candidate; showResult(candidate);
      if (!ai) { notify(candidate.workflow!.run!.message); return; }
      if (!candidate.layout || candidate.mode !== "compose") { finish("fallback", `${layoutCompletion(candidate)}；此模板使用本地套版`); return; }
      requestRevision = projectRevision(candidate);
      await checkpoint("AI 增强", candidate);
      if (active.signal.aborted) { finish("cancelled", "AI 增强已取消，当前工作稿已保留"); return; }
      if (latest.current.id !== candidate.id || projectRevision(latest.current) !== requestRevision) { finish("stale", "稿件或材料已修改，未发送模型请求"); return; }
      setProject((current) => current.workflow?.run?.id === runId ? { ...current, workflow: { ...current.workflow, run: { ...current.workflow.run, requests: null } } } : current, "rule");
      const result = await requestAgentPlan(layoutRequest(candidate), active.signal);
      if (active.signal.aborted) { finish("cancelled", "AI 增强已取消，当前工作稿已保留", result.requests ?? 1, result.usage); return; }
      if (latest.current.id !== candidate.id || projectRevision(latest.current) !== requestRevision) { finish("stale", "稿件或材料已修改，过期增强结果未应用", result.requests ?? 1, result.usage); return; }
      const enhanced = applyLayoutDecisions(latest.current, result.plan);
      setProject((current) => {
        if (current.id !== candidate!.id || projectRevision(current) !== requestRevision) return current;
        return { ...enhanced, workflow: { ...enhanced.workflow!, run: { ...enhanced.workflow!.run!, status: "enhanced", inputRevision: projectRevision(enhanced), message: layoutCompletion(enhanced), requests: result.requests ?? 1, usage: result.usage } } };
      }, "model");
      notify(layoutCompletion(enhanced));
    } catch (error) {
      const message = error instanceof Error ? error.message : "增强失败";
      if (candidate && latest.current.workflow?.run?.id === runId) finish(active.signal.aborted ? "cancelled" : "fallback", active.signal.aborted ? "AI 增强已取消，当前工作稿已保留" : `当前本地稿已保留：${message}`, requestRevision ? null : 0);
      else notify(message);
    } finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  };
  return { busy, run, cancel };
}
