import { sanitizeArticleHtml } from "../html-policy";
import { helloWeekDefinition as definition } from "./definition";

export interface WeeklyFixedContent { email: string; contactPerson: string; organization: string }
export const emptyWeeklyFixedContent: WeeklyFixedContent = { email: "", contactPerson: "", organization: "" };
export const hasWeeklyFixedContent = (value: WeeklyFixedContent) => Object.values(value).every((field) => field.trim());
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function fixedModule(kind: "contact" | "credits", settings: WeeklyFixedContent) {
  const element = document.createElement("section");
  element.className = "tn-comp-top-level";
  element.dataset.layoutModule = `weekly-${kind}`;
  element.style.cssText = "box-sizing:border-box;max-width:100%;";
  element.innerHTML = definition.modules[kind].frame.replace(/\{\{(email|contactPerson|organization)\}\}/g, (_match, key: keyof WeeklyFixedContent) => escape(settings[key]));
  return element;
}

/** Apply the current template to both new copy and saved v1 HTML. Local details never enter the copy or template archive. */
export function applyHelloWeekTemplate(html: string, settings: WeeklyFixedContent = emptyWeeklyFixedContent) {
  const holder = document.createElement("template");
  holder.innerHTML = sanitizeArticleHtml(html);
  const root = holder.content.querySelector('[data-layout-artifact="opslion-hello-week/v1"]');
  if (!root) return holder.innerHTML;
  for (const item of root.querySelectorAll('[data-layout-module="weekly-news"], [data-layout-module="weekly-notice"]')) {
    const heading = item.firstElementChild?.firstElementChild;
    if (!(heading instanceof HTMLElement)) continue;
    // A styled paragraph avoids editor heading presets; the inner strong also carries explicit text formatting.
    const title = document.createElement("p");
    title.style.cssText = heading.style.cssText;
    title.style.fontSize = "16px"; title.style.fontWeight = "700"; title.style.color = "#fff";
    const existing = heading.childNodes.length === 1 && heading.firstElementChild?.tagName === "STRONG" ? heading.firstElementChild : null;
    const strong = existing ? existing.cloneNode(true) as HTMLElement : document.createElement("strong");
    strong.style.cssText = "font-size:16px;font-weight:700;color:#fff;";
    if (!existing) strong.innerHTML = heading.innerHTML;
    for (const child of strong.querySelectorAll<HTMLElement>("*")) { child.style.fontSize = "16px"; child.style.fontWeight = "700"; }
    title.append(strong); heading.replaceWith(title);
  }
  for (const category of root.querySelectorAll<HTMLElement>('[data-layout-module="weekly-category"] strong')) {
    category.style.fontSize = "16px"; category.style.fontWeight = "700";
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a")) {
    link.style.textDecoration = "none";
    for (const underline of link.querySelectorAll("u")) underline.replaceWith(...underline.childNodes);
    for (const child of link.querySelectorAll<HTMLElement>("[style]")) if (child.style.textDecoration.includes("underline")) child.style.textDecoration = "none";
  }
  for (const divider of root.querySelectorAll<HTMLElement>('[data-layout-module="weekly-divider"] > p')) {
    divider.style.font = "700 16px/24px Consolas,monospace"; divider.style.color = "#000";
    const strong = document.createElement("strong");
    strong.style.cssText = "font-size:16px;font-weight:700;color:#000;"; strong.textContent = divider.textContent;
    divider.replaceChildren(strong);
  }
  // Legacy copy may contain generated contacts or names. Only the saved template settings are authoritative.
  root.querySelectorAll('[data-layout-module="weekly-contact"], [data-layout-module="weekly-credits"]').forEach((node) => node.remove());
  const contactAnchor = root.querySelector('[data-layout-module="weekly-code-outro"], [data-layout-module="weekly-closing"], [data-layout-module="weekly-footer"]');
  if (contactAnchor) contactAnchor.before(fixedModule("contact", settings)); else root.append(fixedModule("contact", settings));
  const footer = root.querySelector('[data-layout-module="weekly-footer"]');
  if (footer) footer.before(fixedModule("credits", settings)); else root.append(fixedModule("credits", settings));
  return sanitizeArticleHtml(holder.innerHTML);
}
