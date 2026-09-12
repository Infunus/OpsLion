import { sanitizeArticleHtml } from "./html-policy";
import { renderHelloWeek } from "./weekly-template/render";

export interface WeeklyCopy {
  name: string;
  format: "markdown" | "text";
  text: string;
  importedAt: string;
}

/** A template receives the complete source. Import never extracts or infers fields. */
export interface WeeklyCopyTemplate {
  id: string;
  name: string;
  render: (copy: Readonly<WeeklyCopy>) => string | ReturnType<typeof renderHelloWeek>;
}

export const weeklyCopyTemplate: WeeklyCopyTemplate = { id: "hello-week/v1", name: "Hello Week 周报", render: (copy) => renderHelloWeek(copy.text) };

export function renderWeeklyCopy(copy: WeeklyCopy, template: WeeklyCopyTemplate | null = weeklyCopyTemplate) {
  if (!template) return { ready: false, html: "", title: "", moduleCount: 0, newsCount: 0, message: "未选择周报模板，文案已原样保存。" };
  try {
    const rendered = template.render(Object.freeze({ ...copy }));
    const info = typeof rendered === "string" ? { html: rendered, title: "", moduleCount: 0, newsCount: 0 } : rendered;
    const html = sanitizeArticleHtml(info.html);
    return { ...info, html, ready: !!html.trim(), message: html.trim() ? `${template.name} · ${info.moduleCount} 个模块 · ${info.newsCount} 条资讯` : "模板未生成排版内容，原文已保留。" };
  } catch (error) {
    return { ready: false, html: "", title: "", moduleCount: 0, newsCount: 0, message: error instanceof Error ? error.message : "模板暂时无法排版这份文案，原文已保留。" };
  }
}

export async function readWeeklyCopy(file: File): Promise<WeeklyCopy> {
  if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请选择 Markdown（.md）或纯文本（.txt）文案");
  if (file.size > 10 * 1024 * 1024) throw new Error("文案文件超过 10 MB，请检查是否选择了推文资料包");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error("请将文案保存为 UTF-8 编码后导入"); }
  if (!text.trim()) throw new Error("文案文件为空，当前草稿已保留");
  if (text.includes("\0")) throw new Error("请选择文本文件，当前文件包含二进制内容");
  return { name: file.name, format: /\.(md|markdown)$/i.test(file.name) ? "markdown" : "text", text, importedAt: new Date().toISOString() };
}
