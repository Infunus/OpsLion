import { applyHelloWeekTemplate, type WeeklyFixedContent } from "./fixed-content";
import { safeImageUrl, safeLinkUrl, sanitizeArticleHtml } from "../html-policy";
import { helloWeekDefinition as definition, type HelloWeekDocument, type WeeklyModule } from "./definition";
import { parseHelloWeek, WeeklyFormatError } from "./parse";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const frame = (source: string, slots: Record<string, string>) => source.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, key: string) => {
  if (!(key in slots)) throw new Error(`模板缺少 ${key} 槽位`);
  return slots[key];
});
const asset = (name: keyof typeof definition.assets) => definition.assets[name];
const image = (src: string, alt: string, width = "100%", inline = false) => `<img src="${escape(src)}" alt="${escape(alt)}" style="display:${inline ? "inline-block" : "block"};vertical-align:middle;box-sizing:border-box;width:${width};max-width:100%;height:auto;margin:${inline ? "0" : "0 auto"};" />`;

function codeHtml(value: string, translucent = false) {
  const tokens = /("(?:\\.|[^"\\])*"|\/\/[^\n]*|\b(?:include|using|namespace|class|int|void|return|printf|puts|atexit)\b|<[^>\n]*>)/g;
  let result = "", cursor = 0;
  for (const match of value.matchAll(tokens)) {
    result += escape(value.slice(cursor, match.index));
    const token = match[0], color = token.startsWith('"') ? "#ff0055" : token.startsWith("//") ? "#999" : token.startsWith("<") ? "#2799ed" : "#ca7d37";
    result += `<span style="color:${color};${token.startsWith("//") ? "font-style:italic;" : ""}">${escape(token)}</span>`;
    cursor = match.index! + token.length;
  }
  result += escape(value.slice(cursor));
  return `<pre style="box-sizing:border-box;max-width:100%;margin:0;padding:16px 28px;background:${translucent ? "rgba(0,0,0,0.03)" : "#f7f7f7"};color:#0f1330;font:14px/26px Consolas,monospace;letter-spacing:0;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;">${result}</pre>`;
}

/** Parentheses in source URLs are balanced instead of truncating at the first ')'. */
function markdownLink(text: string, start: number, line: number) {
  const labelStart = start + 1; let end = labelStart, brackets = 1;
  for (; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (text[end] === "[") brackets++;
    if (text[end] === "]" && --brackets === 0) break;
  }
  if (text[end + 1] !== "(") return null;
  let close = end + 2, depth = 1;
  for (; close < text.length; close++) {
    if (text[close] === "\\") { close++; continue; }
    if (text[close] === "(") depth++;
    if (text[close] === ")" && --depth === 0) break;
  }
  if (depth) throw new WeeklyFormatError("链接缺少右括号；URL 中的空格请使用 %20", line);
  return { label: text.slice(labelStart, end), url: text.slice(end + 2, close).trim(), end: close + 1 };
}

function inline(text: string, line: number, nested = false): { html: string; links: number } {
  let html = "", links = 0, index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && index + 1 < text.length && /[\\`*_[\]()>!#]/.test(text[index + 1])) { html += escape(text[index + 1]); index += 2; continue; }
    if (text.startsWith("![", index)) throw new WeeklyFormatError("图片必须独占一行，使用 ![说明](图片地址)", line);
    if (text[index] === "[") {
      const link = markdownLink(text, index, line);
      if (link) {
        if (nested) throw new WeeklyFormatError("链接中不能嵌套链接", line);
        const href = safeLinkUrl(link.url);
        if (!href || /\s/.test(link.url)) throw new WeeklyFormatError("原文链接需要完整的 HTTP(S) 地址", line);
        const label = inline(link.label, line, true);
        if (!link.label.trim()) throw new WeeklyFormatError("原文链接文字为空", line);
        html += `<a href="${escape(href)}" style="color:#337ab7;text-decoration:none;overflow-wrap:anywhere;">${label.html}</a>`; links++; index = link.end; continue;
      }
    }
    const mark = text.startsWith("**", index) ? "**" : text[index] === "`" ? "`" : "";
    if (mark) {
      const close = text.indexOf(mark, index + mark.length);
      if (close < 0) throw new WeeklyFormatError(`未闭合的 ${mark} 标记`, line);
      const value = text.slice(index + mark.length, close);
      if (mark === "**") { const inner = inline(value, line, nested); html += `<strong style="font-weight:700;">${inner.html}</strong>`; links += inner.links; }
      else html += `<code style="font-family:Consolas,monospace;white-space:pre-wrap;">${escape(value)}</code>`;
      index = close + mark.length; continue;
    }
    html += escape(text[index]); index++;
  }
  return { html, links };
}

function picture(text: string, line: number) {
  const parsed = markdownLink(text, 1, line);
  if (!parsed || parsed.end !== text.length) throw new WeeklyFormatError("图片格式为 ![说明](图片地址)，每张图片单独一行", line);
  if (parsed.url.startsWith("asset:")) {
    const name = parsed.url.slice(6) as keyof typeof definition.assets;
    if (!Object.hasOwn(definition.assets, name)) throw new WeeklyFormatError(`未知模板素材 ${name}`, line);
    const item = asset(name); return image(item.src, parsed.label || item.label, item.width);
  }
  const src = safeImageUrl(parsed.url);
  if (!src || !/^https?:\/\//.test(src)) throw new WeeklyFormatError("配图需要 HTTP(S) 地址或模板内的 asset:素材ID；本机路径不能随 Markdown 导入", line);
  return image(src, parsed.label);
}

function markdown(body: string, startLine: number, centered = false) {
  const lines = body.split("\n"); let html = "", links = 0, pictures = 0;
  const format = (text: string, line: number) => { const result = inline(text, line); links += result.links; return result.html; };
  const block = (content: string, margin = "0 0 14px") => `<p style="margin:${margin};line-height:inherit;overflow-wrap:anywhere;">${content}</p>`;
  for (let i = 0; i < lines.length;) {
    const current = lines[i], line = startLine + i;
    if (!current.trim()) { i++; continue; }
    if (current.startsWith("```")) {
      if (!/^```(?:cpp|text)?$/.test(current)) throw new WeeklyFormatError("代码块仅支持 ```、```cpp 或 ```text", line);
      const code: string[] = []; i++;
      while (i < lines.length && lines[i] !== "```") code.push(lines[i++]);
      if (i === lines.length) throw new WeeklyFormatError("代码块缺少结束标记 ```", line);
      html += `<section style="margin:12px 0;">${codeHtml(code.join("\n"), centered)}</section>`; i++; continue;
    }
    if (current.startsWith("![")) { html += `<section style="margin:18px 0;">${picture(current, line)}</section>`; pictures++; i++; continue; }
    if (/^#{1,6} /.test(current)) {
      if (!current.startsWith("#### ")) throw new WeeklyFormatError("模块内的小标题请使用 ####；条目标题放在 :::news 后", line);
      html += block(`<strong style="font-weight:700;">${format(current.slice(5), line)}</strong>`, "14px 0 5px"); i++; continue;
    }
    if (current.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { quote.push(format(lines[i].slice(2), startLine + i)); i++; }
      html += `<table style="width:100%;border-collapse:separate;border-spacing:0;margin:18px 0;"><tbody><tr><td style="width:34px;vertical-align:top;padding-top:7px;">${image(asset("avatar").src, "", "24px")}</td><td style="padding:10px 12px;background:#89b1e6;border-radius:10px;color:#fff;font-size:12.25px;line-height:24.5px;text-align:left;">${quote.join("<br>")}</td></tr></tbody></table>`; continue;
    }
    if (/^(?:\||[*+] )/.test(current)) throw new WeeklyFormatError("此处请使用 - 字段名：字段值 列表；不支持表格或其他列表标记", line);
    if (/^(?:- |\d+\. )/.test(current)) {
      const marker = current.match(/^(?:- |(\d+)\. )/)!; const entries = [format(current.slice(marker[0].length), line)]; i++;
      while (i < lines.length && /^ {2}\S/.test(lines[i])) { entries.push(format(lines[i].slice(2), startLine + i)); i++; }
      html += block(`<span style="color:#89b1e6;font-weight:700;">${marker[1] ? escape(marker[1]) + "." : "✓"}</span> ${entries.join("<br>")}`, "0 0 4px"); continue;
    }
    if (/^\s+\S/.test(current)) throw new WeeklyFormatError("缩进续行必须紧跟列表项，并且恰好使用两个空格", line);
    const paragraph: string[] = [format(current, line)]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:```|!\[|#|> |\d+\. |- |\s+\S|\||[*+] )/.test(lines[i])) { paragraph.push(format(lines[i], startLine + i)); i++; }
    html += block(paragraph.join("<br>"));
  }
  return { html, links, pictures };
}

function renderModule(module: WeeklyModule, document: HelloWeekDocument) {
  const spec = definition.modules[module.kind];
  const rendered = ["markdown", "news", "image"].includes(spec.body) ? markdown(module.body, module.bodyLine, ["closing", "welcome"].includes(module.kind)) : { html: "", links: 0, pictures: 0 };
  if (spec.body === "news" && !rendered.links) throw new WeeklyFormatError("资讯条目需要至少一个 [原文标题](原文链接)，以便直接跳转来源", module.line);
  if (spec.body === "image" && !rendered.pictures) throw new WeeklyFormatError("配图模块需要至少一张 ![说明](图片地址)", module.line);
  const title = inline(module.title, module.line).html;
  const intro = '#include <this week>\n#include <next week>\nusing namespace Weekly;\nclass Contribution; // 投稿类\nclass Academic; // 学术类\nclass Activities; // 活动类\nclass Notification; // 其他信息\nint main()\n{\n' + (module.title === "semester-end" ? '  atexit(EndOfSpringSemester());\n' : '') + '  printf("欢迎来到Hello Week!\\n");\n  printf("让我们一起\\n");\n  printf("来看看本期的重要信息吧\\n");';
  const code = module.kind === "code-intro" ? intro : module.kind === "code-outro" ? '  printf("我们下期再见!");\n  return 0;\n}' : module.kind === "transition" ? module.body.split("\n").map((line) => `  printf(${JSON.stringify(line + "\n")});`).join("\n") : module.body;
  const body = rendered.html;
  const content = frame(spec.frame, {
    title, body,
    heading: title ? `<p style="margin:0 0 14px;font-weight:600;">${title}</p>` : "",
    commentHeading: `<p style="margin:0 0 14px;font-weight:600;">// 【${title || "联系我们"}】</p>`,
    banner: image(asset("banner").src, asset("banner").label), footer: image(asset("footer").src, asset("footer").label),
    sectionIcon: image(asset("section").src, "", "44px", true),
    divider: `＞＞＞${"-".repeat(document.layout === "inset" ? 24 : 32)}`,
    height: module.title, code: spec.frame.includes("{{code}}") ? codeHtml(code) : "",
  });
  return `<section class="tn-comp-top-level" data-layout-module="weekly-${module.kind}" style="box-sizing:border-box;max-width:100%;">${content}</section>`;
}

export function renderHelloWeek(text: string, settings?: WeeklyFixedContent) {
  const document = parseHelloWeek(text), layout = definition.layouts[document.layout];
  const html = applyHelloWeekTemplate(sanitizeArticleHtml(frame(definition.pageFrame, { padding: layout.padding, letterSpacing: layout.letterSpacing, modules: document.modules.filter((module) => module.kind !== "contact" && module.kind !== "credits").map((module) => renderModule(module, document)).join("") })), settings);
  return { html, title: document.title, templateId: document.template, layout: document.layout, moduleCount: document.modules.filter((module) => module.kind !== "contact" && module.kind !== "credits").length + 2, newsCount: document.modules.filter((module) => module.kind === "news").length };
}
