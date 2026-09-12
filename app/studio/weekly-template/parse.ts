import { helloWeekDefinition as definition, type HelloWeekDocument, type WeeklyLayout, type WeeklyModule, type WeeklyModuleKind } from "./definition";

export class WeeklyFormatError extends Error {
  constructor(message: string, readonly line: number) { super(`第 ${line} 行：${message}`); this.name = "WeeklyFormatError"; }
}

/** Decode only the agreed delimiters. No article classification, rewriting or model calls. */
export function parseHelloWeek(text: string): HelloWeekDocument {
  if (text.length > definition.input.maxCharacters) throw new WeeklyFormatError("文案超过模板的 100 万字符上限", 1);
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let cursor = 0;
  const skipEmpty = () => { while (cursor < lines.length && !lines[cursor].trim()) cursor++; };
  skipEmpty();
  if (lines[cursor]?.trim() !== definition.input.marker) throw new WeeklyFormatError(`请从文案示例开始填写；首行需要 ${definition.input.marker}`, cursor + 1);
  cursor++; skipEmpty();
  const title = lines[cursor]?.match(/^# ([^\n]+)$/)?.[1].trim();
  if (!title) throw new WeeklyFormatError("需要 # 本期周报标题", cursor + 1);
  cursor++; skipEmpty();
  const layout = lines[cursor]?.match(/^<!-- layout: (classic|spaced|inset) -->$/)?.[1] as WeeklyLayout | undefined;
  if (!layout) throw new WeeklyFormatError("需要 <!-- layout: classic -->、spaced 或 inset", cursor + 1);
  cursor++;
  const modules: WeeklyModule[] = [];
  let category = false, section = false;
  while (cursor < lines.length) {
    skipEmpty(); if (cursor === lines.length) break;
    const start = cursor;
    const heading = lines[cursor].match(/^:::([a-z][a-z-]*)(?: (.*))?$/);
    if (!heading) throw new WeeklyFormatError("模块外不能放正文；请使用 :::模块ID 开始、::: 结束", cursor + 1);
    const kind = heading[1] as WeeklyModuleKind;
    if (!Object.hasOwn(definition.modules, kind)) throw new WeeklyFormatError(`未知模块 ${kind}，请使用模板说明中的模块 ID`, cursor + 1);
    const spec = definition.modules[kind], headingText = (heading[2] ?? "").trim();
    if (spec.title === "required" && !headingText) throw new WeeklyFormatError(`${spec.name}需要在模块 ID 后填写标题`, cursor + 1);
    if (spec.title === "none" && headingText) throw new WeeklyFormatError(`${spec.name}不接受标题，请把内容写在模块内`, cursor + 1);
    if (spec.title === "intro-mode" && headingText && headingText !== "semester-end") throw new WeeklyFormatError("代码开场仅支持空标题或 semester-end", cursor + 1);
    if (spec.title === "space-size" && !/^(8|12|16|24|28|32|40|48)$/.test(headingText)) throw new WeeklyFormatError("留白高度只能是 8、12、16、24、28、32、40、48", cursor + 1);
    const body: string[] = []; cursor++; let fenced = false;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!fenced && line === ":::") break;
      if (!fenced && line.startsWith(":::")) throw new WeeklyFormatError("上一模块缺少结束标记 :::；模块不能嵌套", cursor + 1);
      if (/^```/.test(line)) fenced = !fenced;
      body.push(line); cursor++;
    }
    if (cursor >= lines.length) throw new WeeklyFormatError(fenced ? "代码块缺少结束标记 ```" : "模块缺少结束标记 :::", start + 1);
    const leadingEmpty = body.findIndex((line) => line !== "");
    const content = body.join("\n").replace(/^\n+|\n+$/g, "");
    if (spec.body === "empty" && content.trim()) throw new WeeklyFormatError(`${spec.name}是固定模块，不能放额外正文`, start + 2);
    if (spec.body !== "empty" && !content.trim()) throw new WeeklyFormatError(`${spec.name}正文为空`, start + 2);
    if (kind === "section") { section = true; category = false; }
    if (kind === "category") { if (!section) throw new WeeklyFormatError("资讯类别前需要 section 分区", start + 1); category = true; }
    if (kind === "news" && !category) throw new WeeklyFormatError("资讯条目前需要 section 分区和 category 类别", start + 1);
    if (["divider", "transition", "notice", "contact", "closing", "credits", "code-outro"].includes(kind)) category = false;
    modules.push({ kind, title: headingText, body: content, line: start + 1, bodyLine: start + 2 + Math.max(0, leadingEmpty) }); cursor++;
    if (modules.length > definition.input.maxModules) throw new WeeklyFormatError("周报超过 500 个模块", start + 1);
  }
  if (!modules.length) throw new WeeklyFormatError("周报没有模块", cursor + 1);
  return { template: "hello-week/v1", title, layout, modules };
}
