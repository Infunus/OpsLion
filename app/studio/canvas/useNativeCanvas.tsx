"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CloneTemplateState, StudioProject } from "../types";
import { renderCloneTemplate } from "../renderer";
import { preparePreviewHtml } from "../preview-assets";
import { useArticleHistory } from "./useArticleHistory";
import { insertNativeModule, placeNativeModule } from "./native-model";
import { readImageFile } from "./model";
import type { NativeEditing } from "./NativeArticle";

export function useNativeCanvas({ project, change, notify, showEditor, showCanvas }: {
  project: StudioProject; change: (state: CloneTemplateState) => void; notify: (message: string) => void; showEditor: () => void; showCanvas: () => void;
}) {
  const state = project.cloneTemplate; const history = useArticleHistory(state ?? undefined, change, project.id);
  const [selected, setSelected] = useState<string | null>(null); const [modulesOpen, setModulesOpen] = useState(false); const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<"before" | "after">("after"); const [focusRequest, setFocusRequest] = useState<NativeEditing["focusRequest"]>(null);
  const input = useRef<HTMLInputElement>(null); const request = useRef<{ scope: string; anchor: string | null; position: "before" | "after"; slot?: string } | null>(null);
  const latest = useRef({ project, history }); useEffect(() => { latest.current = { project, history }; });
  const selectedId = state?.modules.some((module) => module.id === selected && module.included) ? selected : null;
  const selectedLabel = state?.modules.find((module) => module.id === selectedId)?.label ?? "";
  const rendered = useMemo(() => {
    try { return { html: state ? preparePreviewHtml(renderCloneTemplate(project, true)) : "", error: "" }; }
    catch (error) { return { html: "", error: error instanceof Error ? error.message : "模板读取失败" }; }
  }, [project, state]);
  const focus = (id: string) => { setSelected(id); setFocusRequest({ id, nonce: Date.now() }); showCanvas(); };
  const openModules = () => { setModulesOpen(true); setCollapsed(false); showEditor(); };
  const images = async (files: File[], anchor = selectedId ?? undefined, replace?: string, insertionPosition = position) => {
    const scope = project.id; const templateIdentity = state?.analyzedAt; const where = anchor ?? null;
    try {
      if (!files.length) return;
      const urls = await Promise.all(files.map(readImageFile));
      const current = latest.current; let next = current.project.cloneTemplate;
      if (current.project.id !== scope || !next || next.analyzedAt !== templateIdentity) return;
      let id = where;
      if (replace) {
        if (!next.slots.some((slot) => slot.id === replace && slot.kind === "image")) throw new Error("图片位置已变化，请重新选择");
        next = { ...next, slots: next.slots.map((slot) => slot.id === replace ? { ...slot, value: urls[0] } : slot), pendingAssets: next.pendingAssets?.filter((asset) => asset.preferredSlotId !== replace) };
      } else {
        for (const src of urls) { const result = insertNativeModule(next, "image", id, id === where ? insertionPosition : "after", src); next = result.state; id = result.id; }
      }
      current.history.change(next); if (id) focus(id); notify(replace ? "图片已替换" : "图片已插入");
    } catch (error) { notify(error instanceof Error ? error.message : "图片读取失败"); }
  };
  const pick = (slot?: string) => { request.current = { scope: project.id, anchor: selectedId, position, slot }; input.current?.click(); };
  const insert = (kind: string) => {
    if (!state) return;
    if (kind === "image") { pick(); return; }
    try { const result = insertNativeModule(state, kind, selectedId, position); history.change(result.state); focus(result.id); }
    catch (error) { notify(error instanceof Error ? error.message : "插入失败"); }
  };
  const operate: NativeEditing["operate"] = (operation) => {
    if (!state || !selectedId) return;
    try {
      if (operation === "duplicate") { const result = insertNativeModule(state, selectedId, selectedId, "after"); history.change(result.state); focus(result.id); }
      else if (operation === "delete") { history.change({ ...state, modules: state.modules.map((module) => module.id === selectedId ? { ...module, included: false } : module) }); setSelected(null); }
      else { const visible = state.modules.filter((module) => module.included); const index = visible.findIndex((module) => module.id === selectedId); const sibling = visible[index + (operation === "up" ? -1 : 1)]; if (sibling) { history.change(placeNativeModule(state, selectedId, sibling.id, operation === "up" ? "before" : "after")); focus(selectedId); } }
    } catch (error) { notify(error instanceof Error ? error.message : "模块操作失败"); }
  };
  const editing: NativeEditing | undefined = state ? { state, ...rendered, selected: selectedId, selectedLabel, select: setSelected, ...history,
    text: (id, value) => history.change({ ...state, slots: state.slots.map((slot) => slot.id === id ? { ...slot, value } : slot) }, id),
    images, replaceImage: (id) => pick(id), operate, openModules, focusRequest } : undefined;
  return { editing, modulesOpen, collapsed, focus, change: history.change, sidebar: state ? { state, insert, position, setPosition, selectedLabel, collapse: () => { setCollapsed(true); showCanvas(); }, back: () => setModulesOpen(false) } : undefined,
    imagePicker: <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/gif,image/webp,image/avif" aria-label="复刻画布插入图片文件" onChange={(event) => { const pending = request.current; const files = Array.from(event.target.files ?? []); event.target.value = ""; request.current = null; if (pending?.scope === project.id) void images(pending.slot ? files.slice(0, 1) : files, pending.anchor ?? undefined, pending.slot, pending.position); }} /> };
}
