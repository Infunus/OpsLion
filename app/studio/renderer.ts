import type { CompatibilityIssue, StudioProject } from "./types";
import { findTheme } from "./templates";
import { sanitizeArticleHtml, safeImageUrl } from "./html-policy";
import { compileArticle } from "./template-engine/render";
import { renderRichText, richTextToPlain } from "./template-engine/richtext";

export const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const paragraphs = (text: string, style: string) => text
  .split(/\n{2,}/)
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => `<p style="${style}">${escapeHtml(part).replace(/\n/g, "<br>")}</p>`)
  .join("");

const imageBlock = (url: string, caption: string, radius: string) => {
  url = safeImageUrl(url);
  if (!url.trim()) return "";
  return `<section style="margin:18px 0 4px;padding:0;text-align:center;">
    <img src="${escapeHtml(url.trim())}" alt="${escapeHtml(caption || "文章配图")}" style="display:block;width:100%;max-width:100%;height:auto;margin:0 auto;border-radius:${radius};" />
    ${caption ? `<p style="margin:8px 0 0;color:#999;font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(caption)}</p>` : ""}
  </section>`;
};

function renderPlain(project: StudioProject, accent: string) {
  const { content, density } = project;
  const line = density === "compact" ? "1.65" : "1.9";
  const gap = density === "compact" ? "14px" : "22px";
  const body = `margin:0 0 16px;font-size:15px;line-height:${line};overflow-wrap:break-word;`;
  return `<section data-layout-artifact="wechat-agent-studio" style="max-width:100%;box-sizing:border-box;padding:32px 22px;background:#fff;color:#303832;font-family:Arial,'Microsoft YaHei',sans-serif;">
    <h1 style="margin:0 0 16px;font-size:28px;line-height:1.45;overflow-wrap:break-word;">${escapeHtml(content.title)}</h1>
    ${content.subtitle ? paragraphs(content.subtitle, "margin:0 0 22px;color:#747a73;font-size:13px;line-height:1.7;") : ""}
    ${paragraphs(content.lead, body)}
    ${content.sections.filter((item) => item.visible).map((section) => `<section style="margin:0 0 ${gap};">
      ${section.title.trim() ? `<h2 style="margin:0 0 16px;color:${accent};font-size:21px;line-height:1.5;">${escapeHtml(section.title)}</h2>` : ""}
      ${paragraphs(section.body, body)}${imageBlock(section.imageUrl, section.imageCaption, "4px")}
    </section>`).join("")}
    ${paragraphs(content.ending, body)}
  </section>`;
}

export function renderProject(project: StudioProject): string {
  if (project.mode === "compose" && project.layout) {
    if (typeof document === "undefined") return "";
    return compileArticle(project.layout.article, project.layout.template, project.layout.presetId, project.layout.overrides, { nodeVariants: project.layout.nodeVariants }).html;
  }
  if (project.mode === "clone" && project.cloneTemplate?.analyzedHtml) {
    return sanitizeArticleHtml(renderCloneTemplate(project));
  }
  const accent = /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(project.accentOverride) ? project.accentOverride : findTheme(project.theme).accent;
  return sanitizeArticleHtml(renderPlain(project, accent));
}

export function renderCloneTemplate(project: StudioProject, editing = false): string {
  const state = project.cloneTemplate;
  if (!state) return "";
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(state.analyzedHtml, "text/html");
  const safeLinkUrl = (value?: string) => {
    try {
      const parsed = new URL(value?.trim() || "");
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  };
  state.slots.forEach((slot) => {
    const element = doc.querySelector(`[data-layout-slot="${CSS.escape(slot.id)}"]`);
    if (!element) return;
    if (slot.kind === "image") {
      if (slot.value.trim()) element.setAttribute("src", slot.value);
      else if ((project.submission?.draft?.nodes ?? project.submission?.base_draft)?.some((node) => node.type === "image_ref" && project.submission?.native_bindings?.[node.id]?.slot_ids.includes(slot.id))) element.setAttribute("style", "display:none");
      else element.remove();
      const href = safeLinkUrl(slot.linkUrl);
      if (href) { const existing = element.closest("a"); if (existing) existing.setAttribute("href", href); else { const anchor = doc.createElement("a"); anchor.href = href; element.replaceWith(anchor); anchor.append(element); } }
    } else if (slot.richContent && richTextToPlain(slot.richContent) === slot.value) {
      element.replaceChildren(renderRichText(doc, slot.richContent));
    } else if (safeLinkUrl(slot.linkUrl)) {
      const href = safeLinkUrl(slot.linkUrl);
      const existingLink = element.tagName === "A" ? element : element.closest("a");
      const link = existingLink || doc.createElement("a");
      link.setAttribute("href", href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      if (existingLink) {
        element.textContent = `${slot.prefix || ""}${slot.value}${slot.suffix || ""}`;
      } else {
        link.textContent = `${slot.prefix || ""}${slot.value}${slot.suffix || ""}`;
        link.setAttribute("style", "color:inherit;text-decoration:none;");
        element.replaceChildren(link);
      }
    } else {
      element.textContent = `${slot.prefix || ""}${slot.value}${slot.suffix || ""}`;
    }
    if (slot.kind === "text" && slot.value.includes("\n")) {
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT); const texts: Text[] = [];
      while (walker.nextNode()) texts.push(walker.currentNode as Text);
      for (const text of texts) {
        const parts = text.data.split("\n");
        text.replaceWith(...parts.flatMap((part, index) => index ? [doc.createElement("br"), doc.createTextNode(part)] : [doc.createTextNode(part)]));
      }
    }
  });
  doc.querySelectorAll("a").forEach((link) => {
    const linkedSlots = [...link.querySelectorAll<HTMLElement>("[data-layout-slot]")];
    if (!linkedSlots.length) return;
    const shouldUnlink = linkedSlots.every((element) => {
      const slot = state.slots.find((item) => item.id === element.dataset.layoutSlot);
      return !slot || !safeLinkUrl(slot.linkUrl);
    });
    if (shouldUnlink) link.replaceWith(...link.childNodes);
  });
  state.modules.filter((module) => !module.included).forEach((module) => {
    doc.querySelector(`[data-layout-module="${CSS.escape(module.id)}"]`)?.remove();
  });
  for (const node of project.submission?.draft?.nodes ?? project.submission?.base_draft ?? []) {
    if (node.type !== "image_ref") continue;
    const binding = project.submission?.native_bindings?.[node.id];
    const target = binding?.slot_ids[0] ? doc.querySelector(`[data-layout-slot="${CSS.escape(binding.slot_ids[0])}"]`) : binding?.native_path?.reduce<Element | undefined>((parent, index) => parent?.children[index], doc.body);
    if (target) { const note = doc.createElement("p"); note.textContent = `【${node.previous ? "待替换图片" : "待补图片"}：${(project.submission?.plan?.image_requests ?? project.submission?.inherited_requests)?.find((r) => r.id === node.request_id)?.purpose ?? "素材未到"}】`; note.style.cssText = "padding:12px;color:#a54d22;background:#fff3dc;"; const anchor = target.namespaceURI === "http://www.w3.org/2000/svg" ? target.closest("svg")! : target; anchor.before(note); }
  }
  if (!editing) {
    doc.querySelectorAll("[data-layout-slot]").forEach((node) => node.removeAttribute("data-layout-slot"));
    doc.querySelectorAll("[data-layout-module]").forEach((node) => node.removeAttribute("data-layout-module"));
    doc.querySelectorAll("[data-layout-origin]").forEach((node) => node.removeAttribute("data-layout-origin"));
  }
  return doc.body.innerHTML;
}

export function plainTextFromHtml(html: string) {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ");
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\n{3,}/g, "\n\n").trim() || "";
}

export function verifyHtml(html: string): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const doc = typeof DOMParser === "undefined" ? null : new DOMParser().parseFromString(html, "text/html");
  const unsafeNodes = doc ? Boolean(doc.querySelector("script,iframe,form")) || [...doc.querySelectorAll("*")].some((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))) : /<(?:script|iframe|form)\b|<[^>]*\s+on\w+\s*=/i.test(html);
  if (unsafeNodes) issues.push({ level: "error", title: "存在危险节点", detail: "检测到脚本、表单或事件属性；此检查只报告问题，请使用统一清理后的内容。" });
  if (/<style/i.test(html)) issues.push({ level: "warning", title: "包含 Style 标签", detail: "秀米可能不会保留外部样式，建议导入内联样式模板。" });
  if (/display\s*:\s*(flex|grid)/i.test(html)) issues.push({ level: "warning", title: "包含弹性布局", detail: "不同富文本编辑器对 flex/grid 的处理可能不同。" });
  if (/position\s*:\s*(fixed|sticky)/i.test(html)) issues.push({ level: "warning", title: "包含固定定位", detail: "固定定位会在微信兼容处理中失效。" });
  if (/data:image\//i.test(html)) issues.push({ level: "warning", title: "包含内嵌图片", detail: "使用 Bridge 数据包导入，由插件先上传并绑定图片；富文本复制会暂停，避免图片占满秀米草稿缓存。" });
  if (/src=["']http:\/\//i.test(html)) issues.push({ level: "warning", title: "包含非 HTTPS 图片", detail: "建议使用稳定的 HTTPS 图片地址。" });
  const unsafeUrl = doc ? [...doc.querySelectorAll("[href],[src]")].some((element) => /^javascript:/i.test((element.getAttribute("href") || element.getAttribute("src") || "").trim())) : /(?:href|src)\s*=\s*["']?javascript:/i.test(html);
  if (unsafeUrl) issues.push({ level: "error", title: "包含不安全链接", detail: "检测到 javascript: 协议，请使用清理后的链接。" });
  if (!issues.length) issues.push({ level: "info", title: "兼容性良好", detail: "未发现常见的微信富文本兼容问题。" });
  return issues;
}

export function wrapStandaloneHtml(fragment: string, title: string) {
  fragment = sanitizeArticleHtml(fragment);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f3f4ef;"><main style="width:390px;max-width:100%;margin:24px auto;background:#fff;">${fragment}</main></body></html>`;
}
