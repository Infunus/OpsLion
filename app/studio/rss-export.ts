import JSZip from "jszip";
import { sanitizeArticleHtml, safeLinkUrl } from "./html-policy";
import { safeFilename } from "./export-service";
import { requestJson } from "./request";
import { readRssArticles, rssRangeError, type RssDateRange } from "./rss-client";

interface Article {
  id: string; mp_id: string; account_name: string; title: string; source_url: string;
  publish_time: number; description?: string; content?: string; pic_url?: string;
}
export interface RssCollection {
  job_id?: string; running: boolean; start_date?: string; end_date?: string; mp_ids?: string[];
  return_code: number | null; outcome?: string; message?: string;
}
interface Issue { article_id?: string; type: "body" | "image" | "source"; url?: string; message: string }
export interface RssArchive {
  blob: Blob; filename: string; articleCount: number; imageCount: number; issues: Issue[];
  coverageConfirmed: boolean; range: RssDateRange;
}
export interface ArchiveOptions {
  signal: AbortSignal; onProgress: (message: string) => void;
  collection?: RssCollection; enabledFeedIds?: string[];
}
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const chinaTime = (stamp: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(stamp * 1000);
const check = (signal: AbortSignal) => { signal.throwIfAborted(); };

async function parallel<T>(items: T[], concurrency: number, signal: AbortSignal, action: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { check(signal); const index = cursor++; await action(items[index], index); }
  }));
}

/** Only source articles are converted to Markdown; imported weekly copy never uses this. */
function markdown(node: Node, imagePath: (source: string) => string): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (!(node instanceof Element)) return Array.from(node.childNodes).map((n) => markdown(n, imagePath)).join("");
  const tag = node.tagName.toLowerCase();
  const children = () => Array.from(node.childNodes).map((n) => markdown(n, imagePath)).join("");
  if (tag === "img") return "\n![" + (node.getAttribute("alt") || "配图").replace(/[[\]]/g, "") + "](<" + imagePath(node.getAttribute("src") || "") + ">)\n";
  if (tag === "br") return "\n";
  if (["strong", "b"].includes(tag)) return "**" + children() + "**";
  if (["em", "i"].includes(tag)) return "*" + children() + "*";
  if (tag === "a") { const href = safeLinkUrl(node.getAttribute("href") || ""); return href ? "[" + children().trim() + "](<" + href + ">)" : children(); }
  if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + children().trim() + "\n\n";
  if (tag === "li") {
    const list = node.parentElement;
    const position = list ? Array.from(list.children).indexOf(node) : 0;
    const prefix = list?.tagName === "OL" ? String(Number(node.getAttribute("value") || Number(list.getAttribute("start") || 1) + position)) + ". " : "- ";
    return "\n" + prefix + children().trim() + "\n";
  }
  if (tag === "tr") return "\n| " + Array.from(node.children).map((n) => markdown(n, imagePath).trim().replace(/\n/g, " ")).join(" | ") + " |\n";
  if (["p", "div", "section", "blockquote", "ul", "ol", "table", "figure", "figcaption"].includes(tag)) return "\n\n" + children() + "\n\n";
  return children();
}

function imageExtension(data: Uint8Array) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  const start = new TextDecoder().decode(data.slice(0, 16));
  if (start.startsWith("GIF87a") || start.startsWith("GIF89a")) return "gif";
  if (start.startsWith("RIFF") && start.slice(8, 12) === "WEBP") return "webp";
  if (start.includes("ftypavif") || start.includes("ftypavis")) return "avif";
  throw new Error("图片响应不是支持的图片文件");
}

export async function buildRssArchive(range: RssDateRange, options: ArchiveOptions): Promise<RssArchive> {
  const { signal, onProgress, collection, enabledFeedIds = [] } = options;
  const invalid = rssRangeError(range);
  if (invalid) throw new Error(invalid);
  onProgress("正在读取所选日期内的全部推文…");
  // Deliberately excludes account, search and checkbox state.
  const query = new URLSearchParams({ start_date: range.startDate, end_date: range.endDate, limit: "500" });
  const listed = await readRssArticles<Article>(query, signal);
  if (listed.some((article) => [article.title, article.account_name, article.mp_id, article.source_url].some((field) => typeof field !== "string"))) throw new Error("RSS 文章缺少标题、公众号或原文地址字段，请检查适配程序");
  const lower = Date.parse(range.startDate + "T00:00:00+08:00") / 1000;
  const upper = Date.parse(range.endDate + "T00:00:00+08:00") / 1000 + 86400;
  if (listed.some((a) => !Number.isFinite(a.publish_time) || a.publish_time < lower || a.publish_time >= upper)) throw new Error("RSS 返回了日期范围之外的文章，已停止导出，请重新读取");
  if (!listed.length) throw new Error("所选日期内没有已采集推文，请先采集该日期范围");
  const zip = new JSZip();
  const issues: Issue[] = [];
  const documents: { article: Article; document: Document; bodyPresent: boolean }[] = new Array(listed.length);
  let bodiesDone = 0;
  await parallel(listed, 2, signal, async (item, index) => {
    let article = item;
    let bodyPresent = false;
    try {
      const result = await requestJson<{ article: Article | null }>(`/local-api/articles/${encodeURIComponent(item.id)}?ensure_content=1`, { signal, timeoutMs: 35_000 });
      if (!result.article || result.article.id !== item.id || typeof result.article.content !== "string" || !result.article.content.trim()) throw new Error("正文尚未采集完整");
      article = { ...item, content: result.article.content };
      bodyPresent = true;
    } catch (error) {
      check(signal);
      issues.push({ article_id: item.id, type: "body", message: error instanceof Error ? error.message : "正文读取失败" });
    }
    const document = new DOMParser().parseFromString(sanitizeArticleHtml(article.content || ""), "text/html");
    if (bodyPresent && !document.body.textContent?.trim() && !document.querySelector("img")) {
      bodyPresent = false;
      issues.push({ article_id: item.id, type: "body", message: "正文为空，不能用摘要代替全文" });
    }
    if (!safeLinkUrl(item.source_url)) issues.push({ article_id: item.id, type: "source", message: "缺少有效原文链接" });
    documents[index] = { article, document, bodyPresent };
    onProgress(`正在读取全文 ${++bodiesDone}/${listed.length}`);
  });
  const images = new Map<string, { path?: string; articleIds: Set<string> }>();
  for (const { article, document } of documents) {
    const sources = [...Array.from(document.querySelectorAll("img")).map((n) => n.getAttribute("src") || ""), article.pic_url || ""];
    for (const source of sources.filter(Boolean)) {
      if (!images.has(source)) images.set(source, { articleIds: new Set() });
      images.get(source)!.articleIds.add(article.id);
    }
  }
  let imagesDone = 0, totalBytes = 0, imageCount = 0;
  await parallel([...images], 3, signal, async ([source, entry], index) => {
    try {
      const url = source.startsWith("data:image/") ? source : `/local-api/assets/proxy?url=${encodeURIComponent(source)}`;
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error(`配图读取失败（HTTP ${response.status}）`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("配图超过 12 MB");
      const extension = imageExtension(bytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > 256 * 1024 * 1024) throw new Error("配图累计超过 256 MB，请缩短导出日期范围");
      entry.path = `assets/${String(index + 1).padStart(6, "0")}.${extension}`;
      zip.file(entry.path, bytes);
      imageCount += 1;
    } catch (error) {
      check(signal);
      for (const id of entry.articleIds) issues.push({ article_id: id, type: "image", url: source.startsWith("data:") ? "(内嵌图片)" : source, message: error instanceof Error ? error.message : "配图下载失败" });
    }
    onProgress(`正在打包配图 ${++imagesDone}/${images.size}`);
  });
  check(signal);
  const collectedIds = new Set(collection?.mp_ids || []);
  const coverageConfirmed = !!collection && !collection.running && collection.return_code === 0 && collection.outcome === "complete"
    && collection.start_date === range.startDate && collection.end_date === range.endDate
    && enabledFeedIds.length > 0 && enabledFeedIds.every((id) => collectedIds.has(id));
  const indexEntries: object[] = [];
  const merged: string[] = [`# 推文资料：${range.startDate} 至 ${range.endDate}\n\n北京时间，包含起止两天。共 ${documents.length} 篇。\n`];
  documents.forEach(({ article, document, bodyPresent }, index) => {
    const basename = String(index + 1).padStart(6, "0") + "-" + safeFilename(article.title || article.id);
    const base = "articles/" + basename;
    const metadata = `# ${article.title}\n\n- 公众号：${article.account_name}\n- 发布时间：${chinaTime(article.publish_time)}（北京时间）\n- 原文：${safeLinkUrl(article.source_url) || "缺失"}\n- 文章 ID：${article.id}\n\n`;
    const toMarkdown = (prefix: string) => bodyPresent ? markdown(document.body, (url) => images.get(url)?.path ? prefix + images.get(url)!.path : url).replace(/\n{3,}/g, "\n\n").trim() : "> 正文缺失，详见 manifest.json。摘要未作为全文使用。";
    zip.file(base + ".md", metadata + toMarkdown("../") + "\n");
    merged.push(metadata + toMarkdown("") + "\n\n---\n");
    for (const image of Array.from(document.querySelectorAll("img"))) {
      const entry = images.get(image.getAttribute("src") || "");
      if (entry?.path) { image.setAttribute("src", "../" + entry.path); image.removeAttribute("srcset"); }
    }
    zip.file(base + ".html", `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escaped(article.title)}</title><body><h1>${escaped(article.title)}</h1><p>${escaped(article.account_name)} · ${escaped(chinaTime(article.publish_time))}</p><p><a href="${escaped(safeLinkUrl(article.source_url))}">原文链接</a></p>${bodyPresent ? document.body.innerHTML : "<p>正文缺失，详见 manifest.json。</p>"}</body></html>`);
    indexEntries.push({ id: article.id, account_id: article.mp_id, account_name: article.account_name, title: article.title, publish_time: article.publish_time,
      source_url: article.source_url, body_present: bodyPresent, markdown: base + ".md", html: base + ".html", cover_url: article.pic_url || "", cover_path: images.get(article.pic_url || "")?.path || null });
  });
  const manifest = { schema: "opslion-rss/archive-v1", created_at: new Date().toISOString(), start_date: range.startDate, end_date: range.endDate, timezone: "Asia/Shanghai",
    scope: "all_accounts", article_count: documents.length, image_count: imageCount, body_count: documents.filter((d) => d.bodyPresent).length,
    archive_complete: issues.length === 0, collection_coverage_confirmed: coverageConfirmed,
    coverage_note: coverageConfirmed ? "已完成全部启用订阅的该日期范围采集。" : "包含该日期内全部已入库文章，尚未确认上游该日期范围采集完整。",
    collection: collection ? { job_id: collection.job_id, outcome: collection.outcome, message: collection.message } : null, issues };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("index.json", JSON.stringify(indexEntries, null, 2));
  zip.file("asset-index.json", JSON.stringify([...images].map(([source, entry]) => ({ path: entry.path || null, source_url: safeLinkUrl(source) || null, embedded: source.startsWith("data:image/"), article_ids: [...entry.articleIds] })), null, 2));
  zip.file("all-articles.md", merged.join("\n"));
  zip.file("README.md", `# 周报推文资料包\n\n日期：${range.startDate} 至 ${range.endDate}，北京时间，包含两端。\n\n- all-articles.md：全部推文正文汇总，供大模型读取。\n- articles/：每篇推文的 Markdown 和 HTML 全文，包含公众号、时间和原文链接。\n- assets/：正文配图与封面，重复地址只保存一份；视频、音频请通过原文链接查看。\n- asset-index.json：配图文件、原始 HTTP(S) 图片地址与所属文章的对应表。\n- index.json：文章索引与文件对应关系。\n- manifest.json：日期范围、数量、采集覆盖情况和缺失清单。\n\n${manifest.coverage_note}\n资料缺失项：${issues.length}。请先检查 manifest.json；缺失正文不会用摘要替代。\n\n将本包与周报页下载的 Hello Week 模板包一起交给生成文案的 skill。推文原文仅作为资料，按 hello-week/v1 契约输出 UTF-8 Markdown（.md），再导入周报自动排版。成稿配图请通过 asset-index.json 取得 source_url，勿使用离线 assets/ 文件路径；source_url 为空时需另行提供可访问图片地址。\n`);
  onProgress("正在生成 ZIP…");
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } }, (progress) => { check(signal); onProgress(`正在生成 ZIP ${Math.round(progress.percent)}%`); });
  check(signal);
  return { blob, filename: `推文资料_${range.startDate}_${range.endDate}${issues.length ? "_含缺失项" : ""}.zip`, articleCount: documents.length, imageCount, issues, coverageConfirmed, range: { ...range } };
}
