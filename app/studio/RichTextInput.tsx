"use client";
import { useEffect, useRef, useState } from "react";
import { renderRichText } from "./template-engine/richtext";
import { safeLinkUrl } from "./html-policy";
import type { RichText } from "./template-engine/types";

export function readRichTextElement(root: HTMLElement): RichText {
  const output: RichText = [];
  const visit = (parent: Node, active: string[] = [], color?: string) => {
    [...parent.childNodes].forEach((node, index, siblings) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const marks = (["bold", "italic", "underline", "strike"] as const).filter((mark) => active.includes(mark));
        if (node.textContent) output.push({ text: node.textContent, ...(marks.length ? { marks } : {}), ...(color ? { color } : {}) });
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === "BR") { output.push({ break: true }); return; }
      const marks = [...active];
      if (/^(B|STRONG)$/.test(node.tagName) || Number(node.style.fontWeight) >= 600 || node.style.fontWeight === "bold") marks.push("bold");
      if (/^(I|EM)$/.test(node.tagName) || node.style.fontStyle === "italic") marks.push("italic");
      if (node.tagName === "U" || node.style.textDecoration.includes("underline")) marks.push("underline");
      if (/^(S|STRIKE)$/.test(node.tagName) || node.style.textDecoration.includes("line-through")) marks.push("strike");
      const block = /^(DIV|P)$/.test(node.tagName);
      if (block && index > 0 && output.length && !("break" in output[output.length - 1])) output.push({ break: true });
      const rgb = node.style.color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
      const localColor = rgb ? `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : color;
      const start = output.length; visit(node, marks, localColor);
      if (node.tagName === "A" && safeLinkUrl(node.getAttribute("href") ?? "")) {
        const content = output.splice(start).flatMap((part) => "text" in part ? [part] : "break" in part ? [{ text: "\n" }] : part.content);
        output.push({ href: safeLinkUrl(node.getAttribute("href") ?? ""), content });
      }
      if (block && index < siblings.length - 1 && !("break" in (output.at(-1) ?? {}))) output.push({ break: true });
    });
  };
  visit(root); return output;
}

export function RichTextInput({ value, onChange, label, className = "", placeholder = "输入内容…" }: { value: RichText; onChange: (value: RichText) => void; label: string; className?: string; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null); const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element && JSON.stringify(readRichTextElement(element)) !== JSON.stringify(value)) element.replaceChildren(renderRichText(document, value));
  }, [value]);
  const changed = () => { if (ref.current) onChange(readRichTextElement(ref.current)); };
  return <div className={`rich-text-field ${className}`}>
    <div className="rich-text-tools" role="group" aria-label={`${label} 格式`}>
      {[["bold", "加粗", "B"], ["italic", "斜体", "I"], ["underline", "下划线", "U"]].map(([command, name, icon]) => <button key={command} type="button" title={name} aria-label={name} onMouseDown={(event) => event.preventDefault()} onClick={() => { ref.current?.focus(); document.execCommand(command); changed(); }}>{icon}</button>)}
      <button type="button" aria-label="设置链接" onMouseDown={(e) => e.preventDefault()} onClick={() => { const selection = window.getSelection(); if (selection?.rangeCount && ref.current?.contains(selection.anchorNode)) { range.current = selection.getRangeAt(0).cloneRange(); const anchor = selection.anchorNode?.parentElement?.closest("a"); setLink(anchor?.getAttribute("href") ?? ""); } }}>链接</button>
    </div>
    {link !== null && <div className="rich-link-editor"><input aria-label={`${label} 链接地址`} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /><button disabled={!safeLinkUrl(link)} onClick={() => { ref.current?.focus(); const selection = window.getSelection(); if (range.current) { selection?.removeAllRanges(); selection?.addRange(range.current); document.execCommand("createLink", false, safeLinkUrl(link)); changed(); } setLink(null); }}>应用链接</button><button onClick={() => { ref.current?.focus(); const selection = window.getSelection(); if (range.current) { selection?.removeAllRanges(); selection?.addRange(range.current); document.execCommand("unlink"); changed(); } setLink(null); }}>移除链接</button></div>}
    <div ref={ref} role="textbox" tabIndex={0} aria-label={label} aria-multiline="true" className="rich-text-input" contentEditable suppressContentEditableWarning data-placeholder={placeholder}
      onInput={changed} onPaste={(event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); changed(); }} onDrop={(event) => event.preventDefault()} />
  </div>;
}
