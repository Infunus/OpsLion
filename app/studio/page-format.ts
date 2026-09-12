import { z } from "zod";
import { sanitizeArticleHtml } from "./html-policy";

// Keep the measured article surface separate from the editor's outer canvas.
export const pageProperties = ["font-family", "font-size", "line-height", "letter-spacing", "color", "text-align", "text-indent", "padding-top", "padding-right", "padding-bottom", "padding-left", "background-color", "background-image", "background-size", "background-position", "background-repeat"] as const;
export const pageFormatSchema = z.object({
  styles: z.partialRecord(z.enum(pageProperties), z.string().max(2_000_000)),
  source: z.object({ selector: z.string().max(300), url: z.string().max(4000).optional(), capturedAt: z.string().max(50).optional() }).optional(),
}).strict();
export type PageFormat = z.infer<typeof pageFormatSchema>;

export function cleanPageFormat(input: unknown): PageFormat {
  const format = pageFormatSchema.parse(input);
  const element = document.createElement("section");
  for (const [property, value] of Object.entries(format.styles)) {
    element.style.setProperty(property, value);
    if (!element.style.getPropertyValue(property)) throw new Error(`全文格式 ${property} 无效`);
  }
  const holder = document.createElement("template"); holder.innerHTML = sanitizeArticleHtml(element.outerHTML);
  const clean = (holder.content.firstElementChild as HTMLElement).style;
  for (const property of Object.keys(format.styles)) if (!clean.getPropertyValue(property)) throw new Error(`全文格式 ${property} 无法通过样式检查`);
  return { ...format, styles: Object.fromEntries(Object.keys(format.styles).map((property) => [property, clean.getPropertyValue(property)])) };
}
