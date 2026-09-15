import { requestJson } from "./request";

export type RssDateRange = { startDate: string; endDate: string };

export function recentRssDates(days: number): RssDateRange {
  const endDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(`${endDate}T00:00:00+08:00`);
  start.setTime(start.getTime() - (days - 1) * 86400_000);
  const startDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
  return { startDate, endDate };
}

export function rssRangeError({ startDate, endDate }: RssDateRange): string {
  if (!startDate || !endDate) return "请选择完整的开始日期和结束日期";
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(startDate) || !validDate(endDate)) return "请选择有效日期";
  if (startDate > endDate) return "开始日期不能晚于结束日期";
  return "";
}

/** Read every page so date filters and keyword search cover the whole selected range. */
export async function readRssArticles<T extends { id: string }>(query: URLSearchParams, signal: AbortSignal): Promise<T[]> {
  const articles = new Map<string, T>();
  const offsets = new Set<number>();
  let expectedTotal: number | undefined;
  let offset = 0;
  for (;;) {
    if (offsets.has(offset)) throw new Error("文章分页重复，请重新读取数据");
    offsets.add(offset);
    query.set("offset", String(offset));
    const payload = await requestJson<{ articles: T[]; total?: number; next_offset?: number | null }>(`/local-api/articles?${query}`, { signal, timeoutMs: 35_000 });
    if (!Array.isArray(payload.articles) || payload.articles.some((article) => !article || typeof article.id !== "string" || !article.id)) throw new Error("文章列表格式无效，请重新读取");
    if (payload.total !== undefined) {
      if (!Number.isInteger(payload.total) || payload.total < 0) throw new Error("文章总数无效");
      if (expectedTotal !== undefined && expectedTotal !== payload.total) throw new Error("读取期间文章列表发生变化，请重新读取");
      expectedTotal = payload.total;
    }
    for (const article of payload.articles) articles.set(article.id, article);
    if (payload.next_offset == null) {
      if (expectedTotal !== undefined && articles.size !== expectedTotal) throw new Error("文章分页未完整返回，请重新读取，尚未生成完整资料包");
      return [...articles.values()];
    }
    if (!Number.isInteger(payload.next_offset) || payload.next_offset <= offset) throw new Error("文章分页位置无效");
    offset = payload.next_offset;
  }
}
