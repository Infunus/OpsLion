"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspacePreferences } from "./useWorkspacePreferences";
import {
  createDefaultProject,
  createDefaultSection,
  makeId,
  type CloneTemplateState,
  type ContentSection,
  type SavedCloneTemplate,
  type StudioMode,
  type StudioProject,
} from "./types";
import { removeProject, removeReusableTemplate, saveReusableTemplate, recoveryBackup, saveProjectVersion } from "./storage";
import { parsePlainText } from "./text-parser";
import { importDocx, type DocxImportResult } from "./docx-import";
import { WordImportDialog, type WordDestination } from "./WordImportDialog";
import { fillTemplateLocally, fillArticleTemplate, templateContentBlockers } from "./local-template-fill";
import { commitSubmission, submissionTemplateName } from "./submission/project";
import { collectBridgeAssets } from "./bridge-contract";
import { analyzeTemplateHtml, duplicateTemplateModule, normalizeTemplateMetadata, pristineTemplateState } from "./template-clone";
import { captureSourceSchema, type CaptureSource } from "./bridge-contract";
import { preparePreviewHtml } from "./preview-assets";
import { setLayoutAIEnabled } from "./agent-client";
import { AgentSettingsModal } from "./AgentSettingsModal";
import {
  applyTemplatePlan,
  canApplyTemplatePlan,
  type AgentTemplatePlan,
} from "./agent-contract";
import { renderProject, verifyHtml } from "./renderer";
import { StudioIcon } from "./StudioIcon";
import { StudioMark } from "./StudioMark";
import { SlidingTabs } from "./SlidingTabs";
import { useProjectPersistence } from "./useProjectPersistence";
import { useAgentWorkflow, agentSource, type AgentReview } from "./useAgentWorkflow";
import { createExportActions, downloadBlob, safeFilename } from "./export-service";
import { cleanCapturedTitle, normalizeProjectTemplate, articleMentionsImage } from "./project-utils";
import { parseProjectFile } from "./project-schema";
import { findTheme } from "./templates";
import { requestJson } from "./request";
import { ComposeEditor, CloneEditor } from "./Editors";
import { StylePanel, CloneInspector } from "./Inspectors";
import { ModalDialog } from "./ModalDialog";
import { PreviewStage } from "./PreviewStage";
import { LegacyContentEditor } from "./canvas/LegacyContentEditor";
import { WeeklyWorkspace } from "./WeeklyWorkspace";
import { LayoutEditor } from "./LayoutEditor";
import { LayoutLibrary } from "./LayoutLibrary";
import { LayoutStylePanel } from "./LayoutStylePanel";
import { adaptLegacyArticle, articleToLegacyContent, plainLayout, compileArticle, createLayoutState, explainLayoutError, parsedArticleSchema, type ParsedArticle, type TemplateDefinition } from "./template-engine";
import { SubmissionPanel } from "./submission/SubmissionPanel";
import { ContentReview } from "./submission/ContentReview";
import { emptySubmission } from "./submission/ingest";
import { syncDraftEdits, submissionBlockers } from "./submission/assemble";
import { captureBaseline, syncNativeEdits } from "./submission/baseline";
import { LayoutChecks } from "./workflow/LayoutChecks";
import { layoutCompletion } from "./workflow/document";
import { useLayoutRun } from "./workflow/run-layout";
import type { Submission } from "./submission/types";
import { TemplateModules } from "./canvas/TemplateModules";
import { rebaseNativeBindings } from "./canvas/native-model";
import { NativeModules } from "./canvas/NativeModules";
import { useNativeCanvas } from "./canvas/useNativeCanvas";
import { useCanvasEditor } from "./canvas/useCanvasEditor";

type Modal = "none" | "export" | "projects" | "templates" | "layout-templates" | "agent" | "agent-review" | "submission";
const cloneProject = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function StudioApp() {
  const { dark, setDark, previewWidth, setPreviewWidth, ready: preferencesReady } = useWorkspacePreferences();
  const { project, setProject, projects, setProjects, savedTemplates, setSavedTemplates, hydrated, saveState, storageNotice, flushProject } = useProjectPersistence();
  const [view, setView] = useState<StudioMode>("compose");
  const [weeklyVisited, setWeeklyVisited] = useState(false);
  const [previewFocus, setPreviewFocus] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState("editor");
  const [modal, setModal] = useState<Modal>("none");
  const [toast, setToast] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [rawText, setRawText] = useState("");
  const [rawImportOpen, setRawImportOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState("");
  const captureSourceRef = useRef<{ html: string; source: CaptureSource } | null>(null);
  const [cloneName, setCloneName] = useState("年度活动模板");
  const [clonePanel, setClonePanel] = useState<"slots" | "modules">("slots");
  const [docxImporting, setDocxImporting] = useState(false);
  const [wordImport, setWordImport] = useState<DocxImportResult | null>(null);
  const wordSourceRef = useRef("");
  const articleContexts = useRef(new WeakMap<ParsedArticle, StudioProject>());
  const nativeContexts = useRef(new WeakMap<CloneTemplateState, StudioProject>());
  useEffect(() => {
    if (project.layout) articleContexts.current.set(project.layout.article, project);
    if (project.cloneTemplate) nativeContexts.current.set(project.cloneTemplate, project);
  }, [project]);
  const [libraryArticle, setLibraryArticle] = useState<ParsedArticle | null>(null);
  useEffect(() => {
    if (!previewFocus && !inspectorOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (inspectorOpen) {
        setInspectorOpen(false);
        document.querySelector<HTMLButtonElement>(".inspector-trigger")?.focus();
      } else {
        setPreviewFocus(false);
        document.querySelector<HTMLButtonElement>(".focus-preview")?.focus();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [previewFocus, inspectorOpen]);
  const importProjectRef = useRef<HTMLInputElement>(null);
  const importHtmlRef = useRef<HTMLInputElement>(null);
  const importDocxRef = useRef<HTMLInputElement>(null);
  const modelDocxRef = useRef<HTMLInputElement>(null);
  const docxImportModeRef = useRef<"compose" | "clone">("compose");

  useEffect(() => {
    if (!hydrated) return;
    // Restore only after persisted state is available.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setView(project.mode);
      if (new URLSearchParams(window.location.search).get("templateImport") !== "1") return;
      try {
        const captureId = new URLSearchParams(window.location.search).get("capture") || "";
        const payload = await requestJson<{ template?: { id: string; html: string; title?: string; source?: CaptureSource } }>(`/local-api/templates/pending?id=${encodeURIComponent(captureId)}`, { signal: controller.signal });
        if (controller.signal.aborted || !payload.template?.html) return;
        const state = analyzeTemplateHtml(payload.template.html, payload.template.title || "抓取的排版模板", payload.template.source);
        captureSourceRef.current = state.source ? { html: state.sourceHtml, source: state.source } : null;
        setProject((current) => ({ ...current, mode: "clone", name: state.name, cloneTemplate: state }));
        setView("clone"); setCloneSource(state.sourceHtml); setCloneName(state.name); setToast("已接收排版模板");
        await requestJson(`/local-api/templates/pending?consume=1&id=${encodeURIComponent(payload.template.id)}`, { signal: controller.signal }).catch(() => undefined);
      } catch { if (!controller.signal.aborted) setToast("没有收到模板包，请回到 Bridge 重新发送"); }
      finally { if (!controller.signal.aborted) window.history.replaceState({}, "", window.location.pathname); }
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const rendering = useMemo(() => {
    try { return { html: hydrated ? renderProject(project) : "", error: "" }; }
    catch (error) { return { html: "", error: explainLayoutError(error) }; }
  }, [project, hydrated]);
  const html = rendering.html;
  const previewHtml = useMemo(() => preparePreviewHtml(html), [html]);
  const issues = useMemo(() => {
    const result = verifyHtml(html);
    for (const detail of submissionBlockers(project.submission ?? undefined)) result.unshift({ level: "error", title: "交稿待完成", detail });
    if (project.mode === "clone") for (const detail of templateContentBlockers(project.cloneTemplate)) result.unshift({ level: "error", title: "内容未排入", detail });
    if (rendering.error) result.unshift({ level: "error", title: "模板排版未完成", detail: rendering.error });
    const template = project.cloneTemplate;
    const documentImageCount = project.content.sections.filter((section) => section.imageUrl.trim()).length;
    const hasNewTemplateImage = template?.slots.some((slot) => slot.kind === "image" && slot.role === "content_image" && slot.value.trim() && slot.value !== slot.originalValue);
    if (project.mode === "clone" && template && (template.pendingAssets?.length || (articleMentionsImage(project.content) && documentImageCount === 0 && !hasNewTemplateImage))) {
      result.unshift({ level: "warning", title: "存在待补图片", detail: "正文可继续排版；正式导出前请补齐二维码或配图，并确认没有沿用往年内容图。" });
    }
    if (project.mode === "clone" && template?.draftWarnings?.length) {
      result.unshift({ level: "warning", title: "本地套版提示", detail: template.draftWarnings.join("；") });
    }
    return result;
  }, [html, project, rendering.error]);

  const updateProject = (patch: Partial<StudioProject>) => setProject((current) => ({ ...current, ...patch }));
  const updateContent = (patch: Partial<StudioProject["content"]>) => setProject((current) => {
    const content = { ...current.content, ...patch };
    return { ...current, content, ...(current.layout ? { layout: { ...current.layout, article: adaptLegacyArticle(content, current.layout.article.id) } } : {}) };
  });
  const updateArticle = (article: ParsedArticle) => setProject((current) => {
    const restored = articleContexts.current.get(article);
    if (restored?.id === current.id) return restored;
    return current.layout ? { ...current, layout: { ...current.layout, article }, content: articleToLegacyContent(article), ...((current.submission?.applied || current.submission?.base_draft) ? { submission: syncDraftEdits(current.submission, article) } : {}) } : current;
  });
  const openSubmission = () => { if (!project.submission) updateProject({ submission: emptySubmission() }); setModal("submission"); };
  const submissionNodes = project.submission?.draft?.nodes ?? project.submission?.base_draft ?? [];
  const pendingImages = Object.fromEntries(submissionNodes.filter((node) => node.type === "image_ref").map((node) => [node.id, true]));
  const canvas = useCanvasEditor({ layout: project.layout, change: updateArticle, scope: project.id,
    pending: pendingImages,
    notify: setToast, openSubmission, showEditor: () => { setMobilePanel("editor"); setPreviewFocus(false); }, showCanvas: () => setMobilePanel("preview") });
  const checkpoint = async (reason: string, snapshot = project) => { const version = await saveProjectVersion(snapshot, reason); setProjects((all) => [version, ...all]); };
  const updateSubmission = (mutate: (state: Submission) => Submission) => setProject((current) => {
    if (!current.submission || current.submission.id !== project.submission?.id) return current;
    try { return commitSubmission(current, mutate(current.submission)); }
    catch (error) { queueMicrotask(() => setToast(explainLayoutError(error))); return current; }
  });
  const applySubmission = async (submission: Submission) => {
    try {
      let target = project;
      if (submission.mode === "update" && submission.base_article_id !== project.id) throw new Error("修改任务的基准稿已变化，请回到对应项目");
      if (submission.mode !== "update") {
        await flushProject();
        const base = submission.mode === "derive" ? [project, ...projects].find((p) => p.id === submission.base_article_id) : project;
        if (!base) throw new Error("派生基准稿已不可用");
        const id = makeId("project");
        target = { ...base, id, workflow: undefined, createdAt: new Date().toISOString(), name: submission.mode === "derive" ? `${base.name}（副本）` : submission.documents.find((d) => submission.main_document_ids.includes(d.id))?.name.replace(/\.docx$/i, "") || "交稿文章" };
        submission = { ...submission, draft: submission.draft ? { ...submission.draft, id } : undefined };
      }
      const next = commitSubmission(target, submission);
      if (submission.mode === "update") await checkpoint("交稿修改");
      setProject(next); setView(next.mode); setModal("none"); setToast("交稿已组装，可继续编辑和补图"); return true;
    } catch (error) { setToast(explainLayoutError(error)); return false; }
  };
  const openLayoutLibrary = () => {
    try { setLibraryArticle(project.layout?.article ?? adaptLegacyArticle(project.content, project.id)); setModal("layout-templates"); }
    catch (error) { setToast(explainLayoutError(error)); }
  };
  const applyLayoutTemplate = (template: TemplateDefinition, presetId: string | null) => {
    try {
      const article = project.layout?.article ?? adaptLegacyArticle(project.content, project.id);
      const layout = { ...createLayoutState(article, template), presetId };
      compileArticle(article, layout.template, presetId);
      updateProject({ mode: "compose", layout }); setView("compose"); setModal("none"); setToast(`已套用“${template.name}”，内容已按模板重新排版`);
    } catch (error) { setToast(explainLayoutError(error)); }
  };
  const updateSection = (id: string, patch: Partial<ContentSection>) => updateContent({
    sections: project.content.sections.map((section) => section.id === id ? { ...section, ...patch } : section),
  });

  const changeView = (next: StudioMode) => {
    setView(next);
    setMobilePanel("editor");
    setPreviewFocus(false);
    setInspectorOpen(false);
    if (next === "weekly") setWeeklyVisited(true);
    if (next !== "weekly") updateProject({ mode: next });
  };

  const addSection = () => updateContent({ sections: [...project.content.sections, createDefaultSection(project.content.sections.length)] });
  const duplicateSection = (index: number) => {
    const next = [...project.content.sections];
    next.splice(index + 1, 0, { ...cloneProject(next[index]), id: makeId("section"), title: `${next[index].title}（副本）` });
    updateContent({ sections: next });
  };
  const removeSection = (index: number) => {
    if (project.content.sections.length === 1) return setToast("至少保留一个内容模块");
    updateContent({ sections: project.content.sections.filter((_, itemIndex) => itemIndex !== index) });
  };
  const moveSection = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= project.content.sections.length) return;
    const next = [...project.content.sections];
    [next[index], next[target]] = [next[target], next[index]];
    updateContent({ sections: next });
  };

  const parseRawText = () => {
    if (!rawText.trim()) return setToast("请先粘贴需要排版的文案");
    updateContent(parsePlainText(rawText));
    setRawImportOpen(false);
    setToast("已识别标题与内容模块，排版已更新");
  };

  const handleImageFile = (sectionId: string, file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setToast("请选择图片文件");
    if (file.size > 5 * 1024 * 1024) return setToast("预览图片请控制在 5MB 内");
    const reader = new FileReader();
    reader.onload = () => updateSection(sectionId, { imageUrl: String(reader.result || "") });
    reader.readAsDataURL(file);
  };

  const handleDocxImport = async (file?: File) => {
    if (!file) return;
    setDocxImporting(true);
    try {
      wordSourceRef.current = agentSource(project);
      setWordImport(await importDocx(file));
    } catch (error) { setToast(error instanceof Error ? error.message : "DOCX 读取失败"); }
    finally { setDocxImporting(false); if (importDocxRef.current) importDocxRef.current.value = ""; }
  };

  const applyWordImport = async (incoming: ParsedArticle, destination: WordDestination) => {
    if (wordSourceRef.current !== agentSource(project)) throw new Error("文稿已修改，请重新选择 Word 后核对");
    if (!wordImport) return;
    if (destination === "selected") {
      const selected = canvas.editing?.selected;
      const current = project.layout?.article;
      if (!selected || !current) throw new Error("请先在画布选择要替换的内容");
      const target = current.nodes.find((node) => node.id === selected)!;
      if (pendingImages[selected]) throw new Error("此处是待补图片，请在交稿与素材中补图或明确取消图片需求");
      const replacements = target.type === "article_title" ? [{ ...incoming.nodes[0], id: target.id }] : incoming.nodes.filter((node) => node.type !== "article_title" && node.type !== "subtitle").map((node) => ({ ...node, id: makeId("word-node"), ...("items" in node ? { items: node.items.map((item) => ({ ...item, id: makeId("word-item") })) } : {}) }));
      const article = parsedArticleSchema.parse({ ...current, nodes: current.nodes.flatMap((node) => node.id === selected ? replacements : [node]) });
      await checkpoint("局部 Word 导入"); canvas.change(article);
    } else {
      const id = destination === "new" ? makeId("project") : project.id;
      const article = { ...incoming, id };
      let next: StudioProject = { ...project, id, name: wordImport.bundle.request.source.document_name.replace(/\.docx$/i, ""), content: articleToLegacyContent(article), submission: null, updatedAt: new Date().toISOString(), ...(destination === "new" ? { createdAt: new Date().toISOString() } : {}) };
      const layout = project.layout ? { ...project.layout, article } : createLayoutState(article, plainLayout);
      if (docxImportModeRef.current === "clone") {
        if (!project.cloneTemplate) throw new Error("请先选择历史模板，再导入 Word");
        next = { ...next, mode: "clone", cloneTemplate: fillArticleTemplate(article, project.cloneTemplate).state, layout };
      } else next = { ...next, mode: "compose", layout };
      if (destination === "new") await flushProject(); else await checkpoint("Word 导入");
      setProject(next); setView(next.mode);
    }
    setWordImport(null); setRawImportOpen(false); setToast("Word 已导入；修改前的稿件可在项目中恢复");
  };

  const chooseDocx = (mode: "compose" | "clone") => {
    docxImportModeRef.current = mode;
    importDocxRef.current?.click();
  };

  const analyzeClone = () => {
    try {
      const state = analyzeTemplateHtml(cloneSource, cloneName, captureSourceRef.current?.html === cloneSource ? captureSourceRef.current.source : undefined);
      setProject((current) => ({ ...current, mode: "clone", name: cloneName || current.name, cloneTemplate: state }));
      setClonePanel("slots");
      setToast(`识别到 ${state.slots.length} 个替换位和 ${state.modules.length} 个模块`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "模板分析失败");
    }
  };

  const updateCloneTemplate = (next: CloneTemplateState) => setProject((current) => {
    const restored = nativeContexts.current.get(next);
    if (restored?.id === current.id) return restored;
    try { return { ...current, cloneTemplate: next, ...((current.submission?.applied || current.submission?.base_draft) && current.cloneTemplate ? { submission: rebaseNativeBindings(syncNativeEdits(current.submission, current.cloneTemplate, next), current.cloneTemplate, next) } : {}) }; }
    catch (error) { queueMicrotask(() => setToast(error instanceof Error ? error.message : "模块位置更新失败")); return current; }
  });
  const nativeCanvas = useNativeCanvas({ project, change: updateCloneTemplate, notify: setToast, showEditor: () => { setMobilePanel("editor"); setPreviewFocus(false); }, showCanvas: () => setMobilePanel("preview") });
  const updateCloneSlot = (id: string, value: string) => {
    const state = project.cloneTemplate;
    if (!state) return;
    const original = state.slots.find((slot) => slot.id === id)?.originalValue || "";
    updateCloneTemplate({
      ...state,
      slots: state.slots.map((slot) => slot.id === id ? { ...slot, value } : slot),
      pendingAssets: value.trim() && value !== original
        ? state.pendingAssets?.filter((asset) => asset.preferredSlotId !== id)
        : state.pendingAssets,
    });
  };
  const updateCloneSlotLink = (id: string, linkUrl: string) => {
    const state = project.cloneTemplate;
    if (!state) return;
    updateCloneTemplate({ ...state, slots: state.slots.map((slot) => slot.id === id ? { ...slot, linkUrl } : slot) });
  };
  const updateCloneSlotRole = (id: string, role: NonNullable<CloneTemplateState["slots"][number]["role"]>) => {
    const state = project.cloneTemplate;
    if (!state) return;
    updateCloneTemplate({ ...state, slots: state.slots.map((slot) => slot.id === id ? { ...slot, role } : slot) });
  };
  const handleCloneImageFile = (id: string, file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setToast("请选择图片文件");
    if (file.size > 5 * 1024 * 1024) return setToast("预览图片请控制在 5MB 内");
    const reader = new FileReader();
    reader.onload = () => {
      updateCloneSlot(id, String(reader.result || ""));
      setToast("图片已补入当前模板槽，导出前请检查清晰度");
    };
    reader.readAsDataURL(file);
  };
  const toggleCloneModule = (id: string) => {
    const state = project.cloneTemplate;
    if (!state) return;
    updateCloneTemplate({ ...state, modules: state.modules.map((module) => module.id === id ? { ...module, included: !module.included } : module) });
  };
  const duplicateClone = (id: string) => {
    if (!project.cloneTemplate) return;
    updateCloneTemplate(duplicateTemplateModule(project.cloneTemplate, id));
    setToast("已按原样复制模块，可继续修改副本内容");
  };
  const runLocalTemplateFill = async () => {
    if (!project.cloneTemplate) return;
    if (project.layout) {
      const filled = fillArticleTemplate(project.layout.article, project.cloneTemplate);
      await checkpoint("本地套版"); updateCloneTemplate(filled.state); setClonePanel("slots");
      setToast(filled.state.unplacedContent?.length ? `模板已填写，另有 ${filled.state.unplacedContent.length} 项内容待排入` : "已按当前文稿填入模板，强调和链接已保留"); return;
    }
    const result = fillTemplateLocally(project.content, project.cloneTemplate);
    await checkpoint("本地套版");
    updateCloneTemplate(result.state);
    setClonePanel("slots");
    const review = result.report.lowConfidenceMatches || result.report.unmatchedSegments || result.report.pendingImages;
    setToast(review
      ? `本地套版已更新 ${result.report.changedSlots} 个槽位，有 ${review} 项匹配问题待处理`
      : `本地套版已更新 ${result.report.changedSlots} 个槽位`);
  };
  const restoreClone = () => {
    if (!project.cloneTemplate) return;
    if (!window.confirm("恢复模板导入时的原始文字、图片、链接和模块结构？当前替换内容会被覆盖，但已导入的新版文案仍会保留。")) return;
    updateCloneTemplate(pristineTemplateState(project.cloneTemplate));
    setToast("已恢复模板原稿，当前导入的新版文案仍保留");
  };
  const resolvePendingAsset = (id: string) => {
    if (!project.cloneTemplate) return;
    updateCloneTemplate({
      ...project.cloneTemplate,
      pendingAssets: project.cloneTemplate.pendingAssets?.filter((asset) => asset.id !== id),
      excludedContent: [...(project.cloneTemplate.excludedContent ?? []), { id, text: project.cloneTemplate.pendingAssets?.find((asset) => asset.id === id)?.purpose ?? "配图", reason: "用户明确不使用此处配图" }],
    });
    setToast("已记录此处配图不再使用");
  };

  const { agentConfig, setAgentConfig, agentBusy, agentReview, setAgentReview, cancelAgent, runContentAgent, runWordAgent, runTemplateAgent } = useAgentWorkflow(project, updateCloneTemplate, setToast, setModal);
  const layoutRun = useLayoutRun({ project, projects, setProject, ai: Boolean(agentConfig?.layout_ai_enabled), flush: flushProject, checkpoint,
    showResult: (next) => { setView(next.mode); setModal("none"); setMobilePanel("preview"); }, notify: setToast });
  const workflowHint = layoutRun.busy ? "正在自动排版与检查…" : !project.workflow?.run ? "导入模板与材料，自动排版并检查成稿"
    : ["local", "enhanced"].includes(project.workflow.run.status) || issues.some((issue) => issue.level === "error") ? layoutCompletion(project, issues) : `上次排版：${project.workflow.run.message}`;
  const setExecutionMode = async (enabled: boolean) => {
    if (enabled && !agentConfig?.configured) { setModal("agent"); setToast("配置模型后，可在顶部启用 AI 增强"); return; }
    if (!enabled) { layoutRun.cancel(); cancelAgent(); setAgentReview(null); setAgentConfig((current) => current ? { ...current, layout_ai_enabled: false } : current); }
    setPolicyBusy(true);
    try { setAgentConfig(await setLayoutAIEnabled(enabled)); }
    catch (error) { setToast(error instanceof Error ? error.message : "执行方式未保存"); }
    finally { setPolicyBusy(false); }
  };
  const startLayout = () => {
    if (!project.submission && !project.layout && !project.cloneTemplate) { openSubmission(); return; }
    void layoutRun.run();
  };
  const chooseModelDocx = () => { if (!agentConfig?.configured) { setModal("agent"); setToast("请先配置模型"); } else modelDocxRef.current?.click(); };
  const { copyRichText, copySource, openTransferPage, downloadHtml, downloadBridge, exportProject } = createExportActions(project, html, issues, setToast, () => setModal("none"));
  const backupStorage = async () => { downloadBlob(JSON.stringify(await recoveryBackup(), null, 2), "opslion-recovery.json", "application/json"); };
  const applyAgentResult = async () => {
    if (!agentReview) return;
    if (agentReview.source !== agentSource(project)) { setToast("内容已变化，请重新分析"); return; }
    try {
      if (agentReview.kind === "content") {
        const article = agentReview.article;
        const layout = project.layout ? { ...project.layout, article } : createLayoutState(article, plainLayout);
        compileArticle(article, layout.template, layout.presetId, layout.overrides);
        await checkpoint("模型应用");
        updateProject({ layout, content: articleToLegacyContent(article), ...(project.submission?.applied ? { submission: syncDraftEdits(project.submission, article) } : {}), mode: "compose", ...(agentReview.documentName ? { name: agentReview.documentName } : {}) });
        setView("compose");
        setToast("已应用文案语义，模板已自动完成排版");
      } else if (project.cloneTemplate) {
        const next = applyTemplatePlan(project.cloneTemplate, agentReview.plan, agentReview.images);
        await checkpoint("模型套版");
        updateCloneTemplate(next);
        setToast(next.pendingAssets?.length ? `已完成正文套版，另有 ${next.pendingAssets.length} 项图片可稍后补` : "已按计划更新模板");
      }
      setAgentReview(null);
      setModal("none");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Agent 计划应用失败");
    }
  };

  const importProject = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const payload = JSON.parse(String(reader.result || "{}"));
        const incoming = parseProjectFile(payload);
        await flushProject();
        setProject(normalizeProjectTemplate({ ...incoming, id: makeId("project"), name: `${incoming.name || "导入项目"}（导入）`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        setView(incoming.mode || "compose");
        setModal("none");
        setToast("项目已导入为新副本");
      } catch {
        setToast("无法识别这个项目文件");
      }
    };
    reader.readAsText(file);
  };

  const saveCurrentAsTemplate = async () => {
    if (!project.cloneTemplate) return;
    const now = new Date().toISOString();
    const clean = pristineTemplateState(project.cloneTemplate);
    const name = cleanCapturedTitle(clean.name);
    const duplicate = savedTemplates.find((item) => item.template.sourceHtml === clean.sourceHtml);
    const item: SavedCloneTemplate = {
      id: duplicate?.id || makeId("template"),
      name,
      template: { ...clean, name },
      createdAt: duplicate?.createdAt || now,
      updatedAt: now,
    };
    try { await saveReusableTemplate(item); setSavedTemplates((all) => [item, ...all.filter((entry) => entry.id !== item.id)]); }
    catch { setToast("模板保存失败，请先下载模板备份"); return; }
    setToast(duplicate ? "模板库中的原始模板已更新" : "已保存到本机模板库");
  };

  const useSavedTemplate = (item: SavedCloneTemplate) => {
    const template = normalizeTemplateMetadata(cloneProject(item.template));
    captureSourceRef.current = template.source ? { html: template.sourceHtml, source: template.source } : null;
    setProject((current) => ({ ...current, mode: "clone", cloneTemplate: template, updatedAt: new Date().toISOString() }));
    setCloneSource(template.sourceHtml);
    setCloneName(item.name);
    setView("clone");
    setClonePanel("slots");
    setModal("none");
    setToast(`已载入模板“${item.name}”，当前文案仍保留`);
  };

  const downloadSavedTemplate = (item: SavedCloneTemplate) => downloadBlob(JSON.stringify({
    schema: "opslion-template/v2",
    title: item.name,
    html: item.template.sourceHtml,
    source: item.template.source,
    exportedAt: new Date().toISOString(),
  }, null, 2), `${safeFilename(item.name)}.opslion-template.json`, "application/json;charset=utf-8");

  const importHtmlFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const source = String(reader.result || "");
      captureSourceRef.current = null;
      let payload;
      try { payload = JSON.parse(source); } catch { setCloneSource(source); return; }
      try {
        if (["opslion-template/v1", "opslion-template/v2"].includes(payload?.schema) && typeof payload.html === "string") {
          captureSourceRef.current = payload.source ? { html: payload.html, source: captureSourceSchema.parse(payload.source) } : null;
          setCloneSource(payload.html);
          setCloneName(payload.title || file.name.replace(/\.[^.]+$/, ""));
          setToast("已读取 OpsLion 模板包，请分析结构和替换位");
          return;
        }
        setToast(payload?.schema === "opslion.layout-template/v1" ? "这是文章组件模板，请从文章模板库导入" : "无法识别模板包，请选择 .opslion-template.json 或 HTML");
      } catch (error) { setToast(error instanceof Error ? error.message : "模板包格式无效"); }
    };
    reader.readAsText(file);
  };

  const newProject = async () => {
    try { await flushProject(); } catch { setToast("当前项目未保存，请先导出备份"); return; }
    const next = createDefaultProject();
    next.layout = createLayoutState(adaptLegacyArticle(next.content, next.id), plainLayout);
    setProject(next);
    setView("compose");
    setModal("none");
    setToast("已创建新项目");
  };

  const loadProject = async (item: StudioProject) => {
    if (item.id === project.id) { setModal("none"); return; }
    try { await flushProject(); } catch { setToast("当前项目未保存，请先导出备份"); return; }
    setProject(normalizeProjectTemplate(item));
    setView(item.mode);
    setModal("none");
    setToast("项目已打开");
  };

  return (
    <main className="studio-shell" data-mode={view} aria-busy={!hydrated} inert={!hydrated}>
      {storageNotice && <div className="storage-notice" role="alert"><span>{storageNotice}</span><button onClick={() => void backupStorage()}>下载存储备份</button><button onClick={exportProject}>备份当前项目</button><button onClick={() => setProject({ ...project, id: makeId("project"), name: `${project.name}（编辑副本）`, createdAt: new Date().toISOString() })}>当前编辑存为副本</button><button onClick={() => void flushProject().catch(() => setToast("保存仍未成功，请先备份"))}>重试保存</button></div>}
      <header className="studio-header">
        <div className="brand-lockup" title="运营狮排版台">
          <div className="brand-mark" aria-hidden="true"><StudioMark /></div>
          <h1>运营狮</h1>
        </div>
        <div className="document-heading">
          {view === "weekly" ? <strong className="document-name">周报</strong> : <input className="document-name" aria-label="项目名称" value={project.name} onChange={(event) => updateProject({ name: event.target.value })} />}
          {view !== "weekly" && <span className="save-state" role="status"><i />{saveState}</span>}
        </div>
        <div className="header-controls">
          <SlidingTabs value={view} onChange={changeView} label="工作模式" className="mode-nav" items={[
            { id: "compose", label: "快速排版", icon: "layout" },
            { id: "clone", label: "样式复刻", icon: "layers" },
            { id: "weekly", label: "周报", icon: "calendar" },
          ]} />
          <div className="header-tools">
            <button disabled={!preferencesReady} className="appearance-toggle theme-toggle" aria-label="深色模式" aria-pressed={dark} title={dark ? "切换到浅色模式" : "切换到深色模式"} onClick={() => setDark(!dark)}><StudioIcon name="sun" className="theme-sun" /><StudioIcon name="moon" className="theme-moon" /></button>
            <button className={`agent-status-button icon-button ${agentConfig?.configured ? "configured" : ""}`} aria-label="模型设置" title={agentConfig?.configured ? `模型：${agentConfig.model}` : "模型设置"} onClick={() => setModal("agent")}><StudioIcon name="cpu" /><span className="sr-only">{agentConfig?.model || "模型设置"}</span>{agentConfig?.configured && <i aria-hidden="true" />}</button>
          </div>
        </div>
        <div className="header-actions">
          <div className="header-submission-slot">{view !== "weekly" && <button className="header-projects" aria-label="交稿与素材" onClick={openSubmission}><StudioIcon name="upload" /><span>交稿</span></button>}</div>
          {agentBusy && <button className="small-button" onClick={cancelAgent}>取消模型请求</button>}
          <button className="header-projects" aria-label="项目" onClick={() => setModal("projects")}><StudioIcon name="folder" /><span>项目</span></button>
          <div className="header-export-slot">{view !== "weekly" && <button className="primary-button header-export" aria-label="导出到秀米" onClick={() => setModal("export")} disabled={view === "clone" && !project.cloneTemplate}>导出<StudioIcon name="arrow" /></button>}</div>
        </div>
      </header>

      {weeklyVisited && <div hidden={view !== "weekly"}><WeeklyWorkspace showToast={setToast} /></div>}
      {view !== "weekly" && <>
        <div className="workflow-bar"><div className="workflow-primary"><button className="primary-button" title="自动匹配素材、套用模板并检查成稿" disabled={layoutRun.busy || policyBusy || Boolean(agentBusy)} onClick={startLayout}>{layoutRun.busy ? "正在排版…" : "一键排版"}</button><select aria-label="排版执行方式" value={agentConfig?.layout_ai_enabled ? "ai" : "local"} disabled={policyBusy} onChange={(event) => void setExecutionMode(event.target.value === "ai")}><option value="local">本地排版</option><option value="ai">AI 增强</option></select>{layoutRun.busy && <button className="text-button" onClick={layoutRun.cancel}>取消增强</button>}</div><span className="workflow-hint">{workflowHint}</span><LayoutChecks issues={issues} ready={hydrated && Boolean(html.trim())} busy={layoutRun.busy} run={project.workflow?.run} /></div>
        <SlidingTabs value={mobilePanel} onChange={setMobilePanel} label="工作区域" className="mobile-panel-nav" items={[{ id: "editor", label: "编辑内容" }, { id: "preview", label: "实时预览" }, { id: "style", label: "版式设置" }]} />
        <section className="workspace-grid" data-content-collapsed={view === "clone" ? nativeCanvas.collapsed : Boolean(project.layout) && canvas.collapsed} data-mobile-panel={mobilePanel} data-preview-focus={previewFocus} data-inspector-open={inspectorOpen}>
          {view === "compose" ? project.layout ? (
            <>{canvas.modulesOpen ? <TemplateModules {...canvas.sidebar} /> : <LayoutEditor article={project.layout.article} onChange={canvas.change} openLibrary={openLayoutLibrary} notify={setToast} chooseDocx={() => chooseDocx("compose")} importing={docxImporting} chooseModelDocx={chooseModelDocx} runAgent={runContentAgent} agentBusy={Boolean(agentBusy)} pendingImages={pendingImages} openSubmission={openSubmission} openModules={canvas.openModules} />}</>
          ) : (
            <ComposeEditor
              project={project}
              rawImportOpen={rawImportOpen}
              rawText={rawText}
              setRawText={setRawText}
              setRawImportOpen={setRawImportOpen}
              parseRawText={parseRawText}
              updateProject={updateProject}
              updateContent={updateContent}
              updateSection={updateSection}
              addSection={addSection}
              duplicateSection={duplicateSection}
              removeSection={removeSection}
              moveSection={moveSection}
              handleImageFile={handleImageFile}
              chooseDocx={() => chooseDocx("compose")}
              docxImporting={docxImporting}
              agentConfigured={Boolean(agentConfig?.configured)}
              agentBusy={agentBusy === "content"}
              runAgent={runContentAgent}
              chooseModelDocx={chooseModelDocx}
              openAgentSettings={() => setModal("agent")}
              openLayoutLibrary={openLayoutLibrary}
            />
          ) : nativeCanvas.modulesOpen && nativeCanvas.sidebar ? <NativeModules {...nativeCanvas.sidebar} /> : (
            <CloneEditor
              changeTemplate={updateCloneTemplate}
              project={project}
              cloneSource={cloneSource}
              cloneName={cloneName}
              clonePanel={clonePanel}
              setCloneSource={setCloneSource}
              setCloneName={setCloneName}
              setClonePanel={setClonePanel}
              analyzeClone={analyzeClone}
              updateCloneSlot={updateCloneSlot}
              updateCloneSlotLink={updateCloneSlotLink}
              updateCloneSlotRole={updateCloneSlotRole}
              handleCloneImageFile={handleCloneImageFile}
              toggleCloneModule={toggleCloneModule}
              duplicateClone={duplicateClone}
              restoreClone={restoreClone}
              resolvePendingAsset={resolvePendingAsset}
              resetClone={() => updateProject({ cloneTemplate: null })}
              chooseHtmlFile={() => importHtmlRef.current?.click()}
              chooseDocx={() => chooseDocx("clone")}
              docxImporting={docxImporting}
              agentConfigured={Boolean(agentConfig?.configured)}
              agentBusy={agentBusy === "template"}
              runLocalFill={runLocalTemplateFill}
              runAgent={runTemplateAgent}
              openAgentSettings={() => setModal("agent")}
              saveTemplate={saveCurrentAsTemplate}
              openTemplateLibrary={() => setModal("templates")}
            />
          )}

          <PreviewStage fallbackEditor={view === "compose" && !project.layout ? <LegacyContentEditor content={project.content} change={updateContent} /> : undefined} nativeEditing={view === "clone" ? nativeCanvas.editing : undefined} editing={view === "compose" ? canvas.editing : undefined} visualKey={`${view}:${project.layout?.template.id ?? project.theme}`} focused={previewFocus} toggleFocus={() => setPreviewFocus(!previewFocus)} ready={preferencesReady} width={previewWidth} setWidth={setPreviewWidth} empty={view === "clone" && !project.cloneTemplate} error={rendering.error} html={previewHtml} title={project.content.title || project.name} openInspector={() => setInspectorOpen(!inspectorOpen)} />

          {view === "compose" ? project.layout ? (
            <LayoutStylePanel layout={project.layout} selected={canvas.editing?.selected} issues={issues} update={(layout) => updateProject({ layout, ...((project.submission?.applied || project.submission?.base_draft) ? { submission: syncDraftEdits(project.submission, layout.article) } : {}) })} close={() => setInspectorOpen(false)} openLibrary={openLayoutLibrary} openExport={() => setModal("export")} />
          ) : (
            <StylePanel
              project={project}
              issues={issues}
              close={() => setInspectorOpen(false)}
              updateProject={updateProject}
              openExport={() => setModal("export")}
            />
          ) : (
            <CloneInspector project={project} issues={issues} openExport={() => setModal("export")} close={() => setInspectorOpen(false)} />
          )}
        </section>
      </>}

      {canvas.imagePicker}
      {nativeCanvas.imagePicker}
      {modal === "export" && (
        <ExportModal
          requiresBridge={collectBridgeAssets(html).some((asset) => asset.status !== "remote")}
          issues={issues}
          close={() => setModal("none")}
          copyRichText={copyRichText}
          copySource={copySource}
          openTransferPage={openTransferPage}
          downloadHtml={downloadHtml}
          downloadBridge={downloadBridge}
          exportProject={exportProject}
        />
      )}
      {modal === "projects" && (
        <ProjectsModal
          projects={projects}
          activeId={project.id}
          close={() => setModal("none")}
          newProject={newProject}
          loadProject={loadProject}
          remove={async (id) => { try { await removeProject(id); setProjects((all) => all.filter((item) => item.id !== id)); } catch { setToast("项目删除失败，请重试"); } }}
          exportProject={exportProject}
          chooseImport={() => importProjectRef.current?.click()}
        />
      )}
      {modal === "templates" && (
        <TemplateLibraryModal
          templates={savedTemplates}
          close={() => setModal("none")}
          useTemplate={useSavedTemplate}
          downloadTemplate={downloadSavedTemplate}
          remove={async (id) => { try { await removeReusableTemplate(id); setSavedTemplates((all) => all.filter((item) => item.id !== id)); } catch { setToast("模板删除失败，请重试"); } }}
        />
      )}
      {modal === "layout-templates" && libraryArticle && <LayoutLibrary article={libraryArticle} active={project.layout} close={() => setModal("none")} apply={applyLayoutTemplate} notify={setToast} />}
      {modal === "submission" && project.submission && <SubmissionPanel project={project} projects={projects} configured={Boolean(agentConfig?.configured)} ai={Boolean(agentConfig?.layout_ai_enabled)} runLayout={startLayout} layoutBusy={layoutRun.busy} close={() => setModal("none")} configure={() => setModal("agent")} update={updateSubmission} apply={applySubmission} notify={setToast} />}
      {modal === "agent" && (
        <AgentSettingsModal
          config={agentConfig}
          close={() => setModal("none")}
          saved={(config) => setAgentConfig(config)}
        />
      )}
      {modal === "agent-review" && agentReview && (
        <AgentReviewModal
          project={project}
          review={agentReview}
          close={() => { setModal("none"); setAgentReview(null); }}
          apply={applyAgentResult}
        />
      )}
      <input ref={importProjectRef} type="file" accept=".json,.layout.json" hidden onChange={(event) => importProject(event.target.files?.[0])} />
      <input ref={importHtmlRef} type="file" accept=".html,.htm,.txt,.json,.opslion-template.json" hidden onChange={(event) => importHtmlFile(event.target.files?.[0])} />
      {wordImport && <WordImportDialog imported={wordImport} template={submissionTemplateName(project)} selected={project.mode === "compose" ? canvas.editing?.selected : null} close={() => setWordImport(null)} apply={applyWordImport} />}
      <input ref={importDocxRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => handleDocxImport(event.target.files?.[0])} />
      <input ref={modelDocxRef} aria-label="模型解析 Word 文件" type="file" accept="application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void runWordAgent(file); }} />
      {toast && <div className="toast" role="status"><StudioIcon name="check" /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast("")}><StudioIcon name="close" /></button></div>}
    </main>
  );
}

function ExportModal(props: {
  requiresBridge: boolean;
  issues: ReturnType<typeof verifyHtml>;
  close: () => void;
  copyRichText: (fallback?: boolean) => void;
  copySource: () => void;
  openTransferPage: () => void;
  downloadHtml: () => void;
  downloadBridge: () => Promise<boolean>;
  exportProject: () => void;
}) {
  const [generated, setGenerated] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generate = async () => { setGenerating(true); try { setGenerated(await props.downloadBridge()); } finally { setGenerating(false); } };
  const blocked = props.issues.some((issue) => issue.level === "error");
  return (
    <ModalDialog close={props.close} label="导出到秀米">{(dismiss) => (
      <section className="modal export-modal">
        <header><div><h2>导出文稿</h2></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
        {blocked && <p className="submission-error" role="alert">文稿还有必需内容未处理。可保存项目备份或本地预览，完成后再交付秀米。</p>}
        <div className="recommended-export"><div><span>推荐</span><h3>{props.requiresBridge ? "使用 Bridge 导入秀米" : "复制富文本"}</h3><p>{props.requiresBridge ? "文章包含内嵌或本地图片。先安装扩展，由 Bridge 上传素材并写入秀米模块。" : "复制后可粘贴到秀米；需要独立模块时使用 Bridge。"}</p></div>{props.requiresBridge ? <button className="primary-button" disabled={blocked || generating} onClick={() => void generate()}>{generating ? "正在生成…" : "下载 Bridge 数据包"}</button> : <button className="primary-button" disabled={blocked} onClick={() => props.copyRichText(false)}>复制富文本</button>}</div>
        <ol className="export-steps"><li>{generated ? "✓ 数据包已生成" : "生成数据包"}</li><li>在秀米空白新稿中用扩展导入；同源局部更新需选择原稿</li><li>在秀米保存，重新打开后由扩展验证。生成文件或写入编辑器均未代表保存成功。</li></ol>
        <div className="export-grid">
          <button disabled={props.requiresBridge || blocked} onClick={() => props.copyRichText(true)}><span className="export-icon"><StudioIcon name="copy" /></span><strong>兼容模式复制</strong><p>{props.requiresBridge ? "本稿图片需先经 Bridge 上传。" : "使用传统选区复制。"}</p><b>立即复制 →</b></button>
          <button disabled={props.requiresBridge || blocked} onClick={props.openTransferPage}><span className="export-icon"><StudioIcon name="external" /></span><strong>打开安全复制页</strong><p>{props.requiresBridge ? "本稿请使用上方 Bridge 导入。" : "打开独立页面，手动全选复制。"}</p><b>打开页面 →</b></button>
          <button onClick={props.downloadHtml}><span className="export-icon"><StudioIcon name="download" /></span><strong>下载独立 HTML</strong><p>本地预览文件，用于核对排版。</p><b>下载预览 →</b></button>
          <button disabled={blocked} onClick={props.copySource}><span className="export-icon"><StudioIcon name="code" /></span><strong>复制 HTML 源码</strong><p>复制内联样式源码。</p><b>复制源码 →</b></button>
          <button disabled={blocked || generating} onClick={() => void generate()}><span className="export-icon"><StudioIcon name="package" /></span><strong>Bridge 数据包</strong><p>需要安装扩展，在秀米导入并保存。</p><b>下载 .xiumi.json →</b></button>
          <a className="export-option" href="/downloads/xiumi-bridge-extension.zip" download><span className="export-icon"><StudioIcon name="extension" /></span><strong>浏览器扩展</strong><p>下载 Xiumi Bridge 扩展。</p><b>下载扩展 →</b></a>
        </div>
        <footer><button className="text-button" onClick={props.exportProject}>同时备份项目文件</button><span>{props.issues.filter((item) => item.level !== "info").length ? "导出前仍有兼容性提示" : "✓ 已通过基础兼容性检查"}</span></footer>
      </section>
    )}</ModalDialog>
  );
}

function ProjectsModal(props: {
  projects: StudioProject[];
  activeId: string;
  close: () => void;
  newProject: () => void;
  loadProject: (project: StudioProject) => void;
  remove: (id: string) => void;
  exportProject: () => void;
  chooseImport: () => void;
}) {
  return (
    <ModalDialog close={props.close} label="本机项目">{(dismiss) => (
      <section className="modal projects-modal">
        <header><div><h2>本机项目</h2><p>保存在这台设备上的文稿。</p></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
        <div className="project-actions"><button className="primary-button" onClick={props.newProject}>＋ 新建项目</button><button className="secondary-button" onClick={props.chooseImport}>导入项目</button><button className="secondary-button" onClick={props.exportProject}>备份当前项目</button></div>
        <div className="project-list">{props.projects.length ? props.projects.map((item) => (
          <article className={item.id === props.activeId ? "active" : ""} key={item.id}>
            <button className="project-open" onClick={() => props.loadProject(item)}><span><StudioIcon name={item.mode === "clone" ? "layers" : "edit"} /></span><div><strong>{item.name}</strong><p>{item.mode === "clone" ? "历史模板" : findTheme(item.theme).name} · {new Date(item.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p></div></button>
            <button className="project-delete" onClick={() => props.remove(item.id)} title="删除项目" aria-label={`删除项目：${item.name}`}><StudioIcon name="trash" /></button>
          </article>
        )) : <div className="empty-projects">还没有保存的项目</div>}</div>
      </section>
    )}</ModalDialog>
  );
}

function TemplateLibraryModal(props: {
  templates: SavedCloneTemplate[];
  close: () => void;
  useTemplate: (template: SavedCloneTemplate) => void;
  downloadTemplate: (template: SavedCloneTemplate) => void;
  remove: (id: string) => void;
}) {
  return (
    <ModalDialog close={props.close} label="历史模板库">{(dismiss) => (
      <section className="modal template-library-modal">
        <header><div><h2>历史模板库</h2><p>模板保存在当前浏览器；加载模板只替换版式，不会覆盖已经导入的新版文案。</p></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
        <div className="template-library-note"><b>i</b><span>浏览器数据可能被清理。重要模板请下载模板包，和活动资料一起归档。</span></div>
        <div className="template-library-list">{props.templates.length ? props.templates.map((item) => (
          <article key={item.id}>
            <div><strong>{item.name}</strong><p>{item.template.slots.filter((slot) => slot.kind === "text").length} 个文字槽 · {item.template.slots.filter((slot) => slot.kind === "image").length} 个图片槽 · {new Date(item.updatedAt).toLocaleString("zh-CN")}</p></div>
            <button className="primary-button" onClick={() => props.useTemplate(item)}>使用模板</button>
            <button className="secondary-button" onClick={() => props.downloadTemplate(item)}>下载模板包</button>
            <button className="template-library-delete" onClick={() => { if (window.confirm(`确定从本机模板库删除“${item.name}”吗？`)) props.remove(item.id); }}>删除</button>
          </article>
        )) : <div className="empty-projects">模板库还是空的。导入历史排版后，点击“保存为模板”。</div>}</div>
      </section>
    )}</ModalDialog>
  );
}

function AgentReviewModal(props: { project: StudioProject; review: AgentReview; close: () => void; apply: () => void }) {
  const { review } = props;
  const safe = review.kind === "content" || canApplyTemplatePlan(review.plan);
  const warnings = review.kind === "content" ? review.warnings.map((message) => ({ code: "word_source", message })) : review.plan.warnings;
  const comparison = (() => {
    if (review.kind !== "template" || !props.project.cloneTemplate || !safe) return null;
    try {
      const before = captureBaseline(emptySubmission(), props.project).base_article!;
      const template = applyTemplatePlan(props.project.cloneTemplate, review.plan, review.images);
      const after = captureBaseline(emptySubmission(), { ...props.project, cloneTemplate: template }).base_article!;
      return { before: before.nodes, after: after.nodes };
    } catch { return null; }
  })();
  const operationLabel = (operation: AgentTemplatePlan["operations"][number]) => {
    if (operation.op === "set_text") return `替换文字：${operation.reason}`;
    if (operation.op === "set_link") return `设置链接：${operation.reason}`;
    if (operation.op === "set_image") return `替换配图：${operation.reason}`;
    if (operation.op === "clear_image") return `清除历史内容图：${operation.reason}`;
    if (operation.op === "set_module_visibility") return `${operation.visible ? "恢复" : "隐藏"}模块：${operation.reason}`;
    if (operation.op === "duplicate_module") return `复制模块：${operation.reason}`;
    if (operation.op === "move_module") return `移动模块：${operation.reason}`;
    return `需要人工处理：${operation.message}`;
  };
  return (
    <ModalDialog close={props.close} label="审核排版计划">{(dismiss) => (
      <section className="modal agent-review-modal">
        <header><div><h2>{review.kind === "content" ? "审核文案结构" : "审核模板操作"}</h2><p>{review.model} · {review.latency}ms{review.kind === "template" ? ` · 置信度 ${Math.round(review.plan.confidence * 100)}%` : " · 原文与图片按来源保留"}</p></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
        <div className="agent-review-body">
          {comparison && <ContentReview before={comparison.before} after={comparison.after} />}
          {review.kind === "content" ? (
            <>
              <ContentReview after={review.article.nodes} sources={review.sources} />
            </>
          ) : (
            <div className="agent-review-list">{review.plan.operations.map((operation, index) => <article key={`${operation.op}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{operation.op}</strong><p>{operationLabel(operation)}</p></div></article>)}{review.plan.unresolved.length > 0 && <div className="agent-blocker">仍有 {review.plan.unresolved.length} 项内容无法安全映射，暂不允许自动应用。</div>}{Boolean(review.plan.deferred_assets?.length) && <div className="agent-deferred"><strong>{review.plan.deferred_assets?.length} 项素材稍后补</strong>{review.plan.deferred_assets?.map((asset, index) => <p key={`${asset.purpose}-${index}`}>• {asset.purpose}：{asset.reason}</p>)}</div>}</div>
          )}
          {warnings.length > 0 && <div className="agent-warning-list"><strong>需要留意</strong>{warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>• {warning.message}</p>)}</div>}
          <div className={`agent-apply-state ${safe ? "safe" : "blocked"}`}>{safe ? review.kind === "template" && review.plan.deferred_assets?.length ? "✓ 正文计划可安全应用；待补素材会保留在项目里继续提醒" : "✓ 已通过本地计划校验，可以应用到当前稿件" : "! 计划已保留供查看，但不会部分执行"}</div>
        </div>
        <footer className="agent-modal-actions"><button className="secondary-button" onClick={dismiss}>暂不应用</button><button className="primary-button" onClick={props.apply} disabled={!safe}>应用这个计划</button></footer>
      </section>
    )}</ModalDialog>
  );
}
