"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { compileArticle, explainLayoutError, type LayoutState } from "../template-engine";
import { preparePreviewHtml } from "../preview-assets";
import { useArticleHistory } from "./useArticleHistory";
import { changeModule, changeRichText, createModule, insertModules, moduleLabels, readImageFile } from "./model";
import type { ModuleChoice } from "./TemplateModules";
import type { CanvasEditing } from "./EditableArticle";

export function useCanvasEditor({ layout, change, scope, pending, notify, showEditor, showCanvas, openSubmission }: {
  layout: LayoutState | null | undefined; change: (article: LayoutState["article"]) => void; scope: string;
  pending: Record<string, boolean>; notify: (message: string) => void; showEditor: () => void; showCanvas: () => void; openSubmission: () => void;
}) {
  const [modulesOpen, setModulesOpen] = useState(false); const [collapsed, setCollapsed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null); const [position, setPosition] = useState<"before" | "after">("after");
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const selected = layout?.article.nodes.some((node) => node.id === selection) ? selection : null;
  const history = useArticleHistory(layout?.article, change, scope);
  const imageInput = useRef<HTMLInputElement>(null);
  const target = useRef<{ scope: string; anchor: string | null; position: "before" | "after"; replace?: string; count?: number } | null>(null);
  const latest = useRef({ layout, history, scope }); useEffect(() => { latest.current = { layout, history, scope }; }, [layout, history, scope]);
  const rendered = useMemo(() => {
    if (!layout) return { html: "", error: "" };
    try { return { html: preparePreviewHtml(compileArticle(layout.article, layout.template, layout.presetId, layout.overrides, { editing: true, nodeVariants: layout.nodeVariants }).html, { editing: true }), error: "" }; } catch (error) { return { html: "", error: explainLayoutError(error) }; }
  }, [layout]);
  const focus = (id: string) => { setSelection(id); setFocusRequest({ id, nonce: Date.now() }); showCanvas(); };
  const openModules = () => { setModulesOpen(true); setCollapsed(false); showEditor(); };
  const insert = (kind: ModuleChoice) => {
    if (!layout) return;
    const article = layout.article;
    if (kind === "article_title" || kind === "subtitle") { const existing = article.nodes.find((node) => node.type === kind); if (existing) { focus(existing.id); return; } }
    if (kind === "image" || kind === "image-pair" || kind === "image-triple") { target.current = { scope, anchor: selected, position, count: kind === "image-pair" ? 2 : kind === "image-triple" ? 3 : 1 }; imageInput.current?.click(); return; }
    try {
      const nodes = kind === "chapter" ? [createModule("heading1"), createModule("paragraph")] : [createModule(kind)];
      history.change(insertModules(article, nodes, selected, position)); focus(nodes[0].id);
    } catch (error) { notify(explainLayoutError(error)); }
  };
  const addFiles = async (files: File[], explicit?: { scope: string; anchor: string | null; position: "before" | "after"; replace?: string; count?: number }) => {
    const request = explicit ?? { scope, anchor: selected, position };
    if (!files.length) return;
    if (request.replace && files.length !== 1) { notify("替换图片时请选择一张图片"); return; }
    if (request.count && files.length !== request.count) { notify(`这个组合请选择 ${request.count} 张图片`); return; }
    try {
      const sources = await Promise.all(files.map(readImageFile));
      const current = latest.current; if (current.scope !== request.scope || !current.layout) { notify("当前稿件已切换，请在目标稿重新插图"); return; }
      const article = current.layout.article;
      if (request.replace) {
        const node = article.nodes.find((node) => node.id === request.replace); if (node?.type !== "image") throw new Error("要替换的图片已不存在");
        current.history.change({ ...article, nodes: article.nodes.map((item) => item.id === node.id ? { ...node, src: sources[0], width: undefined, height: undefined } : item) }); focus(node.id);
      } else { const group = crypto.randomUUID(); const nodes = sources.map((src) => ({ ...createModule("image", src), group })); current.history.change(insertModules(article, nodes, request.anchor, request.position)); focus(nodes[0].id); }
    } catch (error) { notify(explainLayoutError(error)); }
  };
  const editing: CanvasEditing | undefined = layout ? {
    article: layout.article, html: rendered.html, error: rendered.error, selected, pending, focusRequest,
    select: setSelection, openModules, openSubmission, ...history,
    text: (source, field, content) => history.change(changeRichText(layout.article, source, field, content), `${source}:${field}`),
    images: (files, anchor) => { void addFiles(files, { scope, anchor: anchor ?? selected, position }); },
    replaceImage: (id) => { target.current = { scope, anchor: id, position, replace: id }; imageInput.current?.click(); },
    operate: (operation) => {
      if (!selected) return;
      if (pending[selected] && operation === "duplicate") { openSubmission(); notify("请先补入图片，再复制此处内容"); return; }
      try { history.change(changeModule(layout.article, selected, operation)); if (operation === "delete") setSelection(null); } catch (error) { notify(explainLayoutError(error)); }
    },
  } : undefined;
  return { editing, change: history.change, modulesOpen, collapsed, openModules, focus,
    sidebar: { layout: layout!, insert, position, setPosition, selectedLabel: selected ? `已选：${moduleLabels[layout!.article.nodes.find((node) => node.id === selected)!.type]}` : "", back: () => setModulesOpen(false), collapse: () => { setCollapsed(true); showCanvas(); } },
    imagePicker: <input type="file" ref={imageInput} hidden multiple accept="image/png,image/jpeg,image/gif,image/webp,image/avif" aria-label="画布插入图片文件" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; const request = target.current; target.current = null; if (request) void addFiles(files, request); }} />,
  };
}
