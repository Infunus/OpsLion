"use client";
import { useEffect, useRef } from "react";
import type { CloneTemplateState } from "../types";
import type { CanvasEditing } from "./EditableArticle";

export interface NativeEditing extends Pick<CanvasEditing, "error" | "selected" | "select" | "undo" | "redo" | "canUndo" | "canRedo" | "operate" | "openModules" | "focusRequest" | "images" | "replaceImage"> {
  state: CloneTemplateState; html: string; selectedLabel: string;
  text: (id: string, value: string) => void;
}

export function NativeArticle({ editing }: { editing: NativeEditing }) {
  const root = useRef<HTMLDivElement>(null); const composing = useRef(false);
  const local = useRef<{ id: string; value: string } | null>(null); const previous = useRef("");
  useEffect(() => {
    const element = root.current; if (!element) return;
    const own = local.current && editing.state.slots.find((slot) => slot.id === local.current!.id)?.value === local.current.value;
    if (previous.current !== editing.html && !own) element.innerHTML = editing.html;
    local.current = null; previous.current = editing.html;
    for (const slot of editing.state.slots) {
      const field = element.querySelector<HTMLElement>(`[data-layout-slot="${CSS.escape(slot.id)}"]`);
      if (!field || slot.kind !== "text") continue;
      field.contentEditable = "plaintext-only"; field.tabIndex = 0; field.setAttribute("role", "textbox");
      field.setAttribute("aria-label", `画布文字 ${slot.label}`); field.setAttribute("aria-multiline", "true"); field.dataset.placeholder = "点击输入文字…";
    }
  }, [editing.html, editing.state]);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>("[data-layout-module]").forEach((element) => {
      if (element.dataset.layoutModule === editing.selected) element.dataset.opSelected = "true";
      else delete element.dataset.opSelected;
    });
  }, [editing.selected, editing.html]);
  useEffect(() => {
    if (!editing.focusRequest) return;
    const element = root.current?.querySelector<HTMLElement>(`[data-layout-module="${CSS.escape(editing.focusRequest.id)}"]`);
    element?.scrollIntoView({ block: "nearest" });
    (element?.matches("[contenteditable]") ? element : element?.querySelector<HTMLElement>("[contenteditable]"))?.focus({ preventScroll: true });
  }, [editing.focusRequest]);
  const commit = (target: EventTarget | null) => {
    if (composing.current || !(target instanceof HTMLElement)) return;
    const field = target.closest<HTMLElement>('[contenteditable="plaintext-only"][data-layout-slot]'); if (!field) return;
    const id = field.dataset.layoutSlot!; const slot = editing.state.slots.find((item) => item.id === id); if (!slot) return;
    let value = field.innerText;
    if (slot.prefix && value.startsWith(slot.prefix)) value = value.slice(slot.prefix.length);
    if (slot.suffix && value.endsWith(slot.suffix)) value = value.slice(0, -slot.suffix.length);
    local.current = { id, value }; editing.text(id, value);
  };
  const select = (target: EventTarget | null) => {
    const id = target instanceof Element ? target.closest("[data-layout-module]")?.getAttribute("data-layout-module") : null;
    if (id) editing.select(id);
  };
  // Delegate events from the native template's keyboard-focusable text fields.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div ref={root} className="editable-article native-editable-article" role="document" aria-label="复刻稿件编辑画布"
    onFocusCapture={(event) => select(event.target)}
    onClickCapture={(event) => { select(event.target); if ((event.target as Element).closest("a")) event.preventDefault(); }}
    onDoubleClick={(event) => { const target = event.target as Element; if (target.tagName === "IMG") { const id = target.getAttribute("data-layout-slot"); if (id) editing.replaceImage(id); } }}
    onInput={(event) => commit(event.target)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; commit(event.target); }}
    onPaste={(event) => { event.preventDefault(); const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (files.length) editing.images(files); else { document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); commit(event.target); } }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { event.preventDefault(); editing.images(Array.from(event.dataTransfer.files), (event.target as Element).closest("[data-layout-module]")?.getAttribute("data-layout-module") ?? undefined); }}
    onKeyDown={(event) => { if (composing.current) return; if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); if (event.key.toLowerCase() === "y" || event.shiftKey) editing.redo(); else editing.undo(); } }} />;
}
