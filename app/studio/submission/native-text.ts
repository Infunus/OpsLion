import type { CloneSlot } from "../types";
import { richTextToPlain } from "../template-engine/richtext";
import type { RichText } from "../template-engine/types";

type Run = { text: string; marks?: Array<"bold" | "italic" | "underline" | "strike">; color?: string; href?: string };
const runs = (value: RichText): Run[] => value.flatMap((part) => "text" in part ? [part] : "break" in part ? [{ text: "\n" }] : part.content.map((run) => ({ ...run, href: part.href })));
const pack = (run: Run): RichText => { const { href, ...text } = run; return href ? [{ href, content: [text] }] : [text]; };
const signature = (run: Run) => JSON.stringify([run.marks?.slice().sort() ?? [], Boolean(run.href)]);

export function readSlotRichText(doc: Document, slot: CloneSlot): RichText {
  if (slot.richContent && richTextToPlain(slot.richContent) === slot.value) return slot.richContent;
  const element = doc.querySelector<HTMLElement>(`[data-layout-slot="${CSS.escape(slot.id)}"]`);
  const run: Run = { text: `${slot.prefix ?? ""}${slot.value}${slot.suffix ?? ""}`, ...(slot.linkUrl ? { href: slot.linkUrl } : {}) };
  const marks = new Set<NonNullable<Run["marks"]>[number]>();
  for (let current = element; current && current !== doc.body; current = current.parentElement) {
    if (/^(STRONG|B)$/.test(current.tagName) || /^(bold|[6-9]00)$/.test(current.style.fontWeight)) marks.add("bold");
    if (/^(EM|I)$/.test(current.tagName) || current.style.fontStyle === "italic") marks.add("italic");
    if (current.tagName === "U" || current.style.textDecoration.includes("underline")) marks.add("underline");
    if (/^(S|STRIKE)$/.test(current.tagName) || current.style.textDecoration.includes("line-through")) marks.add("strike");
    const rgb = current.style.color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (!run.color && rgb) run.color = `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  if (marks.size) run.marks = [...marks];
  return pack(run);
}

/** Use semantic run boundaries, never old character counts. */
export function writeNativeText(doc: Document, slots: CloneSlot[], content: RichText) {
  const old = slots.map((slot) => runs(readSlotRichText(doc, slot)));
  const incoming = runs(content);
  if (old.every((parts) => parts.length === 1) && incoming.length === slots.length && incoming.every((run, index) => signature(run) === signature(old[index][0]))) {
    slots.forEach((slot, index) => {
      const text = incoming[index].text, prefix = slot.prefix ?? "", suffix = slot.suffix ?? "";
      if (text.length >= prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix)) slot.value = text.slice(prefix.length, suffix ? -suffix.length : undefined);
      else { slot.value = text; slot.prefix = ""; slot.suffix = ""; }
      slot.linkUrl = incoming[index].href ?? ""; delete slot.richContent;
      if (incoming[index].color) { const element = doc.querySelector<HTMLElement>(`[data-layout-slot="${CSS.escape(slot.id)}"]`); if (element) element.style.color = incoming[index].color!; }
    });
    return;
  }
  // If runs are added or removed, replace only an exclusively bound inline group.
  const elements = slots.map((slot) => doc.querySelector<HTMLElement>(`[data-layout-slot="${CSS.escape(slot.id)}"]`));
  let root = elements[0]?.parentElement;
  while (root && !elements.every((element) => element && root!.contains(element))) root = root.parentElement;
  const own = new Set(slots.map((s) => s.id));
  if (!root || root === doc.body || root.querySelector("svg,img,table,hr") || root.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6").length > 1 || [...root.querySelectorAll("[data-layout-slot]")].some((el) => !own.has(el.getAttribute("data-layout-slot")!))) throw new Error("此段落包含其他模块，请先在逐项替换中修改对应文字和链接");
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (walker.currentNode.textContent?.trim() && !walker.currentNode.parentElement?.closest("[data-layout-slot]")) throw new Error("此段落包含未绑定文字，请在逐项替换中修改");
  const styled = incoming.flatMap((run) => {
    const matching = old.flat().filter((prior) => signature(prior) === signature(run));
    const colors = new Set(matching.map((prior) => prior.color));
    return pack({ ...run, ...(run.color || colors.size !== 1 ? {} : { color: matching[0]?.color }) });
  });
  slots.forEach((slot, index) => { slot.value = index ? "" : richTextToPlain(styled); slot.prefix = ""; slot.suffix = ""; slot.linkUrl = ""; delete slot.richContent; });
  slots[0].richContent = styled;
  root.replaceChildren(...slots.map((slot) => { const span = doc.createElement("span"); span.setAttribute("data-layout-slot", slot.id); return span; }));
}
