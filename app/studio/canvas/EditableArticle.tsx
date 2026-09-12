"use client";
import { useEffect, useRef } from "react";
import { readRichTextElement } from "../RichTextInput";
import type { ParsedArticle, RichText } from "../template-engine";
import { moduleLabels } from "./model";

export interface CanvasEditing {
  error?: string;
  article: ParsedArticle; html: string; selected: string | null; pending: Record<string, boolean>;
  select: (id: string) => void; text: (source: string, field: string, content: RichText) => void;
  images: (files: File[], anchor?: string) => void; replaceImage: (id: string) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  operate: (operation: "delete" | "duplicate" | "up" | "down") => void;
  openModules: () => void; openSubmission: () => void;
  focusRequest: { id: string; nonce: number } | null;
}

/** Only compiler-bound fields are editable. DOM markup never becomes the saved article. */
export function EditableArticle({ editing }: { editing: CanvasEditing }) {
  const root = useRef<HTMLDivElement>(null); const composing = useRef(false);
  const local = useRef<{ source: string; field: string; value: string } | null>(null);
  const previous = useRef("");
  useEffect(() => {
    const element = root.current; if (!element) return;
    const fieldValue = local.current && editing.article.nodes.flatMap((node) => [{ source: node.id, value: "content" in node ? node.content : node.type === "image" ? node.caption : undefined }, ...("items" in node ? node.items.map((item) => ({ source: item.id, value: item.content })) : [])]).find((item) => item.source === local.current!.source)?.value;
    const ownUpdate = local.current && JSON.stringify(fieldValue ?? []) === local.current.value;
    if (previous.current !== editing.html && !ownUpdate) element.innerHTML = editing.html;
    previous.current = editing.html; local.current = null;
    element.querySelectorAll<HTMLElement>("[data-op-field]").forEach((field) => {
      const id = field.dataset.opNode!; const nodeIndex = editing.article.nodes.findIndex((node) => node.id === id); const node = editing.article.nodes[nodeIndex];
      if (!node) return;
      const editable = !editing.pending[id]; field.contentEditable = String(editable); field.tabIndex = editable ? 0 : -1;
      if (editable) { field.setAttribute("role", "textbox"); field.setAttribute("aria-multiline", "true"); field.setAttribute("aria-label", `画布${field.dataset.opField === "caption" ? "图注" : moduleLabels[node.type]} ${nodeIndex + 1}`); field.dataset.placeholder = field.dataset.opField === "caption" ? "添加图注…" : "点击输入文字…"; }
      else { field.removeAttribute("role"); field.removeAttribute("aria-label"); }
    });
  }, [editing.html, editing.article, editing.pending]);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>("[data-op-node]").forEach((element) => {
      if (element.dataset.opNode === editing.selected && element.dataset.opSource === editing.selected && element.parentElement?.closest("[data-op-node]")?.getAttribute("data-op-node") !== editing.selected) element.dataset.opSelected = "true";
      else delete element.dataset.opSelected;
    });
  }, [editing.selected, editing.html]);
  useEffect(() => {
    const request = editing.focusRequest; if (!request) return;
    const element = root.current?.querySelector<HTMLElement>(`[data-op-node="${CSS.escape(request.id)}"]`);
    if (!element) return;
    element.scrollIntoView({ block: "nearest" });
    const field = element.matches("[data-op-field]") ? element : element.querySelector<HTMLElement>("[data-op-field]"); field?.focus({ preventScroll: true });
  }, [editing.focusRequest]);
  const commit = (target: EventTarget | null) => {
    if (composing.current || !(target instanceof HTMLElement)) return;
    const field = target.closest<HTMLElement>("[data-op-field]"); if (!field || editing.pending[field.dataset.opNode!]) return;
    const content = readRichTextElement(field);
    local.current = { source: field.dataset.opSource!, field: field.dataset.opField!, value: JSON.stringify(content) };
    editing.text(local.current.source, local.current.field, content);
  };
  // Events are delegated from compiler-created, keyboard-focusable textboxes inside this document.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div ref={root} className="editable-article" role="document" aria-label="文章编辑画布"
    onFocusCapture={(event) => { const id = (event.target as HTMLElement).closest<HTMLElement>("[data-op-node]")?.dataset.opNode; if (id) editing.select(id); }}
    onClickCapture={(event) => {
      const target = event.target as HTMLElement; if (target.closest("a")) event.preventDefault();
      const id = target.closest<HTMLElement>("[data-op-node]")?.dataset.opNode;
      if (id) { editing.select(id); if (editing.pending[id]) editing.openSubmission(); }
    }}
    onDoubleClick={(event) => { const target = event.target as HTMLElement; const id = target.closest<HTMLElement>("[data-op-node]")?.dataset.opNode; if (target.tagName === "IMG" && id) editing.replaceImage(id); }}
    onInput={(event) => commit(event.target)}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; commit(event.target); }}
    onPaste={(event) => {
      event.preventDefault(); const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
      if (files.length) { editing.images(files); return; }
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); commit(event.target);
    }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { event.preventDefault(); const id = (event.target as HTMLElement).closest<HTMLElement>("[data-op-node]")?.dataset.opNode; editing.images(Array.from(event.dataTransfer.files), id); }}
    onKeyDown={(event) => {
      if (composing.current) return;
      if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) { event.preventDefault(); if (event.key.toLowerCase() === "y" || event.shiftKey) editing.redo(); else editing.undo(); }
      if (event.key === "Escape") (event.target as HTMLElement).blur();
    }} />;
}
