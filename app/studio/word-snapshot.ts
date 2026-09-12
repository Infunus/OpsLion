import { safeImageUrl, safeLinkUrl } from "./html-policy";
import type { RichText } from "./template-engine";
import type { SemanticBlock, SemanticBundle } from "./semantic-agent";

const children = (element: Element | undefined, name: string) => Array.from(element?.children ?? []).filter((child) => child.localName === name);
const child = (element: Element | undefined, name: string) => children(element, name)[0];
const attr = (element: Element | undefined, name = "val") => Array.from(element?.attributes ?? []).find((item) => item.localName === name)?.value;
const descendants = (element: Element, name: string) => Array.from(element.getElementsByTagNameNS("*", name));
const flag = (element: Element) => !["0", "false", "off", "none"].includes(attr(element) ?? "1");
const formatNumber = (value: number, format?: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) return String(value);
  if (format === "lowerLetter" || format === "upperLetter") { let n = value, result = ""; while (n > 0) { result = String.fromCharCode(65 + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); } return format === "lowerLetter" ? result.toLowerCase() : result; }
  if (format === "lowerRoman" || format === "upperRoman") { let n = value, result = ""; for (const [number, text] of [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]] as const) while (n >= number) { result += text; n -= number; } return format === "lowerRoman" ? result.toLowerCase() : result; }
  return String(value);
};

// Shared by ordinary import, model classification and submission ingestion.
export async function extractWordSnapshot(file: File, options: { revisionView?: "accepted" | "original"; collectAnnotations?: boolean } = {}): Promise<SemanticBundle> {
  if (!/\.docx$/i.test(file.name) || file.size > 30 * 1024 * 1024) throw new Error("请选择 30MB 以内的 .docx 文件");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = async (path: string) => {
    const entry = zip.file(path);
    if (!entry) return undefined;
    const value = await entry.async("string");
    if (value.length > 8 * 1024 * 1024) throw new Error("Word 结构过大，请拆分文档后再解析");
    const doc = new DOMParser().parseFromString(value, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error(`Word XML 损坏：${path}`);
    return doc.documentElement;
  };
  const [documentRoot, stylesRoot, numberingRoot, relationshipsRoot] = await Promise.all([
    xml("word/document.xml"), xml("word/styles.xml"), xml("word/numbering.xml"), xml("word/_rels/document.xml.rels"),
  ]);
  const body = child(documentRoot, "body");
  if (!body) throw new Error("Word 中没有可读取的正文");
  const relationships = new Map(children(relationshipsRoot, "Relationship").map((el) => [attr(el, "Id"), { target: attr(el, "Target") || "", external: attr(el, "TargetMode") === "External" }]));
  const styles = new Map(children(stylesRoot, "style").map((el) => [attr(el, "styleId"), el]));
  const warnings: string[] = [];
  const blocks: SemanticBlock[] = [];
  const commentRanges = new Map<string, Set<string>>();
  const activeComments = new Set<string>();
  const images: SemanticBundle["images"] = new Map();
  const props = (element: Element | undefined): Record<string, string> => Object.fromEntries(Array.from(element?.children ?? []).map((el) => [el.localName, ["b", "i", "u", "strike"].includes(el.localName) ? String(flag(el)) : attr(el) ?? ""]));
  const styleProps = (styleId: string | undefined, kind: "pPr" | "rPr", seen = new Set<string>()): Record<string, string> => {
    if (!styleId || seen.has(styleId)) return {};
    seen.add(styleId); const style = styles.get(styleId);
    return { ...styleProps(attr(child(style, "basedOn")), kind, seen), ...props(child(style, kind)) };
  };
  const defaultStyle = children(stylesRoot, "style").find((style) => attr(style, "type") === "paragraph" && attr(style, "default") === "1");
  const defaults = child(stylesRoot, "docDefaults");
  const counters = new Map<string, number>();
  let paragraphIndex = 0;
  let imageIndex = 0;
  const paragraphs: Array<{ element: Element; table?: { id: string; row: number; column: number } }> = [];
  let tableIndex = 0;
  for (const element of Array.from(body.children)) {
    if (element.localName === "tbl") {
      const id = `table-${++tableIndex}`;
      children(element, "tr").forEach((row, r) => children(row, "tc").forEach((cell, c) => descendants(cell, "p").forEach((p) => paragraphs.push({ element: p, table: { id, row: r + 1, column: c + 1 } }))));
    } else paragraphs.push({ element });
  }
  for (const entry of paragraphs) {
    const paragraph = entry.element;
    if (paragraph.localName === "sectPr") continue;
    const blockers = new Set<string>();
    if (paragraph.localName !== "p") blockers.add(`正文结构 ${paragraph.localName}`);
    if (entry.table) blockers.add("表格：需选择转换方式，单元格文字、强调与链接均已保留");
    paragraphIndex++;
    const paragraphId = `p${String(paragraphIndex).padStart(4, "0")}`;
    const pPr = child(paragraph, "pPr");
    const styleId = attr(child(pPr, "pStyle")) ?? attr(defaultStyle, "styleId");
    const pProperties = { ...props(child(child(defaults, "pPrDefault"), "pPr")), ...styleProps(styleId, "pPr"), ...props(pPr) };
    const runDefaults = { ...props(child(child(defaults, "rPrDefault"), "rPr")), ...styleProps(styleId, "rPr") };
    const clues: Record<string, unknown> = { paragraph_id: paragraphId, style_id: styleId ?? null, style_name: attr(child(styles.get(styleId), "name")) ?? null, paragraph_properties: pProperties, run_properties: [], ...(entry.table ? { table: entry.table } : {}) };
    const numPr = child(pPr, "numPr") ?? child(child(styles.get(styleId), "pPr"), "numPr");
    const numId = attr(child(numPr, "numId"));
    if (numId && numId !== "0") {
      const level = Number(attr(child(numPr, "ilvl")) ?? 0);
      const num = children(numberingRoot, "num").find((el) => attr(el, "numId") === numId);
      const abstract = children(numberingRoot, "abstractNum").find((el) => attr(el, "abstractNumId") === attr(child(num, "abstractNumId")));
      const override = children(num, "lvlOverride").find((el) => Number(attr(el, "ilvl")) === level);
      const definition = child(override, "lvl") ?? children(abstract, "lvl").find((el) => Number(attr(el, "ilvl")) === level);
      const format = attr(child(definition, "numFmt"));
      const start = Number(attr(child(override, "startOverride")) ?? attr(child(definition, "start")) ?? 1);
      if (level !== 0) blockers.add("嵌套列表或多级自动编号");
      if (!format || !["decimal", "bullet"].includes(format)) blockers.add(`自动编号格式 ${format ?? "未知"}`);
      if (!Number.isSafeInteger(start) || start < 1) blockers.add("无效的列表起始编号");
      const counterKey = `${numId}:${level}`;
      const current = counters.get(counterKey) ?? start;
      counters.set(counterKey, current + 1);
      for (let deeper = level + 1; deeper < 9; deeper++) counters.delete(`${numId}:${deeper}`);
      const label = (attr(child(definition, "lvlText")) ?? `%${level + 1}.`).replace(/%(\d+)/g, (_, n) => { const levelIndex = Number(n) - 1; const formatAtLevel = children(abstract, "lvl").find((el) => Number(attr(el, "ilvl")) === levelIndex); return formatNumber(levelIndex === level ? current : Math.max(1, (counters.get(`${numId}:${levelIndex}`) ?? 2) - 1), attr(child(formatAtLevel, "numFmt")) ?? format); });
      clues.numbering = { group: numId, level, ordered: format !== "bullet", start: current, format, label };
    }
    let content: RichText = [];
    let fragment = 0;
    const flush = () => {
      if (!content.length) return;
      blocks.push({ id: `${paragraphId}:${++fragment}`, kind: "paragraph", content, clues }); content = [];
    };
    const walk = async (element: Element, marks: Array<"bold" | "italic" | "underline" | "strike"> = [], href?: string): Promise<void> => {
      const name = element.localName;
      if (options.collectAnnotations && ["commentRangeStart", "commentRangeEnd", "commentReference"].includes(name)) {
        const commentId = attr(element, "id") ?? "";
        if (!commentRanges.has(commentId)) commentRanges.set(commentId, new Set());
        commentRanges.get(commentId)!.add(paragraphId);
        if (name === "commentRangeStart") activeComments.add(commentId);
        if (name === "commentRangeEnd") activeComments.delete(commentId);
        return;
      }
      for (const commentId of activeComments) commentRanges.get(commentId)!.add(paragraphId);
      if (["pPr", "rPr", "bookmarkStart", "bookmarkEnd", "proofErr", "lastRenderedPageBreak", "fldChar", "instrText"].includes(name)) return;
      if (["footnoteReference", "endnoteReference", "object", "pict", "sym", "sdt"].includes(name)) { blockers.add(`Word 内容 ${name}，需核对原文件后处理此位置`); if (!element.children.length) content.push({ text: `【待处理 Word 内容：${name}】` }); }
      if (name === "del" && options.revisionView !== "original") { warnings.push("修订删除内容未作为当前正文，采用文档接受修订后的阅读内容。"); return; }
      if (name === "ins" && options.revisionView === "original") { warnings.push("采用修订前的文本视图，未读取新增文字。"); return; }
      if (name === "r") {
        const rPr = child(element, "rPr");
        const values = { ...runDefaults, ...styleProps(attr(child(rPr, "rStyle")), "rPr"), ...props(rPr) };
        (clues.run_properties as unknown[]).push(values);
        if (values.vertAlign && values.vertAlign !== "baseline") blockers.add("上标或下标");
        const runMarks: typeof marks = [];
        for (const [key, mark] of [["b", "bold"], ["i", "italic"], ["u", "underline"], ["strike", "strike"]] as const) if (values[key] === "true") runMarks.push(mark);
        for (const item of Array.from(element.children)) await walk(item, runMarks, href);
        return;
      }
      if (name === "hyperlink") {
        const target = relationships.get(attr(element, "id"))?.target;
        const link = target ? safeLinkUrl(target) : "";
        if (!link) blockers.add("内部书签或当前模板不支持的链接");
        for (const item of Array.from(element.children)) await walk(item, marks, link || undefined);
        return;
      }
      if (name === "drawing") {
        flush();
        const textBoxes = options.collectAnnotations ? descendants(element, "txbxContent") : [];
        for (const box of textBoxes) for (const boxParagraph of children(box, "p")) {
          const offset = blocks.length;
          for (const item of Array.from(boxParagraph.children)) await walk(item, marks, href);
          flush();
          blocks.slice(offset).forEach((block) => { block.clues = { ...block.clues, floating_text: true, anchor_paragraph_id: paragraphId }; });
        }
        const blips = descendants(element, "blip");
        if (!blips.length && !textBoxes.length) blockers.add("图表、形状或绘图对象");
        for (const blip of blips) {
          const relation = relationships.get(attr(blip, "embed"));
          if (!relation || relation.external) { blockers.add("外链或不可读取的图片"); continue; }
          const target = relation.target.startsWith("/") ? relation.target.slice(1) : `word/${relation.target}`;
          if (target.split("/").includes("..")) { blockers.add("文档目录外的图片引用"); continue; }
          const entry = zip.file(target);
          const extension = target.split(".").pop()?.toLowerCase();
          const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" } as Record<string, string>)[extension ?? ""];
          if (!entry || !mime) { blockers.add("非栅格或缺失的图片"); continue; }
          const src = safeImageUrl(`data:${mime};base64,${await entry.async("base64")}`);
          if (!src) { blockers.add("无效的图片"); continue; }
          const imageId = `image-${++imageIndex}`;
          const alt = attr(descendants(element, "docPr")[0], "descr") ?? "";
          images.set(imageId, { id: imageId, type: "image", src, alt, caption: [] });
          blocks.push({ id: imageId, kind: "image", content: [], image_anchor_id: imageId, clues: { paragraph_id: paragraphId, alt, floating: descendants(element, "anchor").length > 0 } });
        }
        return;
      }
      if (["t", "delText", "tab", "br", "cr", "noBreakHyphen", "softHyphen"].includes(name)) {
        if ((name === "br" || name === "cr") && attr(element, "type") === "page") { warnings.push("分页符作为段内换行保留。"); }
        const text = name === "t" || name === "delText" ? element.textContent ?? "" : name === "tab" ? "\t" : name === "noBreakHyphen" ? "\u2011" : name === "softHyphen" ? "\u00ad" : "\n";
        const color = (clues.run_properties as Array<Record<string, string>>).at(-1)?.color;
        const run = { text, ...(marks.length ? { marks } : {}), ...(/^[a-f\d]{6}$/i.test(color ?? "") ? { color: `#${color}` } : {}) };
        content.push(href ? { href, content: [run] } : text === "\n" ? { break: true } : run);
        return;
      }
      for (const item of Array.from(element.children)) await walk(item, marks, href);
    };
    await walk(paragraph);
    if (blockers.size) {
      clues.conversion = { id: entry.table?.id ?? paragraphId, location: entry.table ? `表格 ${entry.table.id.split("-")[1]} · 第 ${entry.table.row} 行第 ${entry.table.column} 列` : `第 ${paragraphIndex} 段`, reasons: [...blockers] };
      if (!content.length && !blocks.some((b) => b.clues === clues)) content.push({ text: `【待处理：${[...blockers].join("、")}】` });
    }
    flush();
  }
  if (!blocks.length) throw new Error("Word 正文为空");
  const comments = options.collectAnnotations ? await xml("word/comments.xml") : undefined;
  const annotations = children(comments, "comment").map((comment) => ({ id: `comment-${attr(comment, "id")}`, text: descendants(comment, "p").map((p) => descendants(p, "t").map((t) => t.textContent).join("")).join("\n"), source_ids: blocks.filter((block) => commentRanges.get(attr(comment, "id") ?? "")?.has(String(block.clues.paragraph_id))).map((block) => block.id) }));
  return { request: { task: "parse_article_semantics", source: { schema: "opslion/word-snapshot/v1", document_name: file.name, blocks, warnings: [...new Set(warnings)], ...(options.collectAnnotations ? { annotations } : {}) } }, images };
}
