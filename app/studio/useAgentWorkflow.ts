"use client";
import { useEffect, useRef, useState } from "react";
import { loadAgentConfig, requestAgentPlan, type AgentConfig } from "./agent-client";
import { createTemplateAgentRequest, type AgentTemplatePlan } from "./agent-contract";
import { applySemanticPlan, createEditorSemanticRequest, type SemanticPlan } from "./semantic-agent";
import { extractWordSnapshot } from "./word-snapshot";
import type { ParsedArticle } from "./template-engine";
import { submissionBlockers } from "./submission/assemble";
import { segmentCapturedTemplate } from "./template-clone";
import type { CloneTemplateState, StudioProject } from "./types";
import { wordConversions } from "./word-conversion";

export type AgentReview =
  | { kind: "content"; plan: SemanticPlan; article: ParsedArticle; warnings: string[]; sources?: Record<string, import("./submission/types").DraftNode[]>; documentName?: string; latency: number; model: string; source: string }
  | { kind: "template"; plan: AgentTemplatePlan; images: ReturnType<typeof createTemplateAgentRequest>["images"]; latency: number; model: string; source: string };
export const agentSource = (project: StudioProject) => JSON.stringify([project.id, project.content, project.layout?.article, project.cloneTemplate]);

export function useAgentWorkflow(project: StudioProject, updateTemplate: (template: CloneTemplateState) => void, notify: (message: string) => void, open: (modal: "agent" | "agent-review") => void) {
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentBusy, setAgentBusy] = useState<"" | "content" | "template">("");
  const [agentReview, setAgentReview] = useState<AgentReview | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(project);
  useEffect(() => { latest.current = project; }, [project]);
  useEffect(() => {
    const configController = new AbortController();
    void loadAgentConfig(configController.signal).then((config) => { if (!configController.signal.aborted) setAgentConfig(config); }).catch(() => {});
    return () => { configController.abort(); controller.current?.abort(); };
  }, []);
  const cancelAgent = () => { controller.current?.abort(); controller.current = null; setAgentBusy(""); notify("已取消等待模型结果"); };
  const run = async (kind: "content" | "template", file?: File) => {
    if (controller.current) return;
    if (kind === "content" && !file && submissionBlockers(project.submission ?? undefined).length) { notify("当前交稿还有未完成事项，请到交稿与素材中继续处理；正文仍可手动编辑"); return; }
    if (!agentConfig?.configured) { open("agent"); notify("请先配置模型"); return; }
    if (kind === "template" && !project.cloneTemplate) return;
    const template = kind === "template" ? segmentCapturedTemplate(project.cloneTemplate!) : project.cloneTemplate;
    const base = { ...project, cloneTemplate: template };
    if (template && template !== project.cloneTemplate) updateTemplate(template);
    const active = new AbortController(); controller.current = active; setAgentBusy(kind);
    try {
      if (kind === "content") {
        const bundle = file ? await extractWordSnapshot(file) : createEditorSemanticRequest(project);
        const conversions = wordConversions(bundle.request.source.blocks);
        if (conversions.length) throw new Error(`Word 的 ${conversions.map((c) => c.location).join("、")} 需要逐项处理，请打开“导入 Word”选择转换方式后继续。`);
        if (active.signal.aborted) return;
        const result = await requestAgentPlan<SemanticPlan>(bundle.request, active.signal);
        if (active.signal.aborted) return;
        if (agentSource(latest.current) !== agentSource(base)) { notify("内容已修改，请重新运行模型分析"); return; }
        const article = applySemanticPlan(result.plan, bundle, project.layout?.article.id ?? project.id);
        const sources = Object.fromEntries(article.nodes.map((node, index) => [node.id, (result.plan.nodes[index]?.source_ids ?? []).flatMap((id): import("./submission/types").DraftNode[] => {
          const block = bundle.request.source.blocks.find((b) => b.id === id); if (!block) return [];
          const image = block.image_anchor_id ? bundle.images.get(block.image_anchor_id) : undefined;
          return image ? [image] : [{ id, type: "paragraph", content: block.content }];
        })]));
        setAgentReview({ kind, plan: result.plan, article, sources, warnings: bundle.request.source.warnings, documentName: file?.name.replace(/\.docx$/i, ""), latency: result.latency_ms, model: result.model, source: agentSource(base) });
      } else {
        const bundle = createTemplateAgentRequest(project.content, template!);
        const result = await requestAgentPlan<AgentTemplatePlan>(bundle.request, active.signal);
        if (active.signal.aborted) return;
        if (agentSource(latest.current) !== agentSource(base)) { notify("内容已修改，请重新运行模型分析"); return; }
        setAgentReview({ kind, plan: result.plan, images: bundle.images, latency: result.latency_ms, model: result.model, source: agentSource(base) });
      }
      open("agent-review");
    } catch (error) { if (!active.signal.aborted) notify(error instanceof Error ? error.message : "模型请求失败"); }
    finally { if (controller.current === active) { controller.current = null; setAgentBusy(""); } }
  };
  return { agentConfig, setAgentConfig, agentBusy, agentReview, setAgentReview, cancelAgent, runContentAgent: () => run("content"), runWordAgent: (file?: File) => file ? run("content", file) : Promise.resolve(), runTemplateAgent: () => run("template") };
}
