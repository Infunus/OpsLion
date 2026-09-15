import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { mockBridge, ready } from "./helpers";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.setItem("opslion-weekly-source", "rss")); });

const feed = { id: "feed-a", mp_name: "测试公众号甲", status: 1, article_count: 2, update_time: 0, url_count: 2 };
const otherFeed = { ...feed, id: "feed-b", mp_name: "测试公众号乙" };
const article = (id: string, account = feed.id) => ({ id, mp_id: account, account_name: account === feed.id ? feed.mp_name : otherFeed.mp_name, title: "测试推文 " + id,
  source_url: "https://mp.weixin.qq.com/s/" + id, publish_time: Date.parse("2026-09-01T12:00:00+08:00") / 1000, description: "这只是摘要", has_content: 1 });
const imageUrl = "https://mmbiz.qpic.cn/mmbiz_png/synthetic/0";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const text = "\ufeff# 模板标题\r\n\r\n<!-- 固定模板标记 -->\r\n## 栏目一\r\n原样保留 **加粗**、[原文](https://example.test) 与空行。\r\n\r\n<script>window.importExecuted = true</script>\r\n\r\nopslion-asset:" + "a".repeat(64) + "\r\ndata:image/png;base64," + png.toString("base64") + "\r\n";

async function setup(page: Page) {
  await mockBridge(page);
  const state = { refresh: { running: false, return_code: null as number | null, outcome: "", job_id: "", started_at: "", log_tail: "", mp_ids: [] as string[], start_date: "", end_date: "" } };
  await page.route("**/local-api/status", (route) => route.fulfill({ json: { protocol: "opslion-rss/v1", available: true, feeds: [feed, otherFeed], totals: {}, refresh: state.refresh } }));
  await page.route("**/local-api/refresh/status", (route) => route.fulfill({ json: state.refresh }));
  await page.route("**/local-api/articles?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const items = query.get("mp_id") ? [article("first")] : [article("first"), article("second", otherFeed.id)];
    return route.fulfill({ json: { articles: items, next_offset: null } });
  });
  await page.route("**/local-api/articles/*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    return route.fulfill({ json: { article: { ...article(id), content: '<p>完整正文 ' + id + ' ' + "长段落".repeat(180) + ' 全文结尾不能截断</p><img src="' + imageUrl + '"><table><tr><td>日期</td><td>9 月 1 日</td></tr></table>' } } });
  });
  await page.route("**/local-api/assets/proxy?**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-09-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-09-02");
  return state;
}
async function downloadZip(page: Page, button: string) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const download = await downloading;
  return { zip: await JSZip.loadAsync(await readFile(await download.path())), name: download.suggestedFilename() };
}
const importCopy = (page: Page, content = text, name = "处理好的周报.md") => page.getByLabel("导入周报文案文件").setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(content, "utf8") });

test("date ZIP includes every page, full bodies and every account with deduplicated offline images", async ({ page }) => {
  await setup(page);
  const queries: URLSearchParams[] = [];
  await page.route("**/local-api/articles?**", (route) => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    return route.fulfill({ json: query.get("offset") === "500" ? { articles: [article("last", otherFeed.id)], next_offset: null }
      : { articles: [article("first"), article("duplicate")], next_offset: 500 } });
  });
  queries.length = 0;
  let imagesRequested = 0;
  await page.route("**/local-api/assets/proxy?**", (route) => { imagesRequested++; return route.fulfill({ contentType: "image/png", body: png }); });
  const { zip, name } = await downloadZip(page, "导出已有推文 ZIP");
  expect(name).toBe("推文资料_2026-09-01_2026-09-02.zip");
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  const index = JSON.parse(await zip.file("index.json")!.async("string"));
  expect(manifest).toMatchObject({ article_count: 3, body_count: 3, image_count: 1, archive_complete: true, collection_coverage_confirmed: false, timezone: "Asia/Shanghai" });
  expect(index.map((entry: { id: string }) => entry.id)).toEqual(["first", "duplicate", "last"]);
  for (const query of queries) { expect(query.has("mp_id")).toBe(false); expect(query.has("search")).toBe(false); expect(query.get("start_date")).toBe("2026-09-01"); }
  const merged = await zip.file("all-articles.md")!.async("string");
  expect(merged.match(/全文结尾不能截断/g)).toHaveLength(3);
  expect(merged).toContain("测试公众号乙");
  expect(merged).toContain("assets/000001.png");
  expect(merged).toContain("| 日期 | 9 月 1 日 |");
  expect(await zip.file(index[0].html)!.async("string")).toContain('../assets/000001.png');
  expect(await zip.file("assets/000001.png")!.async("nodebuffer")).toEqual(png);
  expect(JSON.parse(await zip.file("asset-index.json")!.async("string"))).toEqual([{ path: "assets/000001.png", source_url: imageUrl, embedded: false, article_ids: ["first", "duplicate", "last"] }]);
  expect(imagesRequested).toBe(1);
  await page.screenshot({ path: "test-results/weekly-transfer-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/weekly-transfer-mobile.png", animations: "disabled" });
});

test("missing bodies and broken images stay in the manifest instead of an automatic complete download", async ({ page }) => {
  await setup(page);
  await page.route("**/local-api/articles/first?**", (route) => route.fulfill({ status: 400, json: { message: "原文需要验证" } }));
  await page.route("**/local-api/assets/proxy?**", (route) => route.fulfill({ status: 502, json: { message: "配图不可用" } }));
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "导出已有推文 ZIP", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载现有资料 ZIP（含缺失清单）", exact: true })).toBeVisible();
  expect(downloads).toBe(0);
  const { zip, name } = await downloadZip(page, "下载现有资料 ZIP（含缺失清单）");
  expect(name).toContain("含缺失项");
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  expect(manifest).toMatchObject({ article_count: 2, body_count: 1, archive_complete: false });
  expect(manifest.issues.map((issue: { type: string }) => issue.type)).toEqual(expect.arrayContaining(["body", "image"]));
  const merged = await zip.file("all-articles.md")!.async("string");
  expect(merged).toContain("测试推文 first");
  expect(merged).toContain("正文缺失");
  expect(merged).not.toContain("这只是摘要");
});

test("an incomplete pagination response cannot become a complete ZIP", async ({ page }) => {
  await setup(page);
  await page.route("**/local-api/articles?**", (route) => route.fulfill({ json: { articles: [article("first")], total: 5, next_offset: null } }));
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "导出已有推文 ZIP", exact: true }).click();
  await expect(page.getByRole("region", { name: "RSS 采集与资料导出" }).getByRole("alert")).toContainText("文章分页未完整返回");
  expect(downloads).toBe(0);
  await expect(page.getByRole("button", { name: "再次下载 ZIP", exact: true })).toHaveCount(0);
});

test("collect-and-export always collects all enabled subscriptions and automatically downloads after completion", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/local-api/refresh", (route) => {
    expect(route.request().postDataJSON()).toEqual({ start_date: "2026-09-01", end_date: "2026-09-02", mp_ids: [] });
    state.refresh = { ...state.refresh, job_id: "all-feeds-job", running: true, mp_ids: [feed.id, otherFeed.id], start_date: "2026-09-01", end_date: "2026-09-02", started_at: "2026-09-11T12:00:00+08:00" };
    return route.fulfill({ json: state.refresh });
  });
  await page.route("**/local-api/refresh/status", (route) => {
    state.refresh = { ...state.refresh, running: false, outcome: "complete", return_code: 0 };
    return route.fulfill({ json: state.refresh });
  });
  const { zip } = await downloadZip(page, "采集并导出 ZIP");
  expect(JSON.parse(await zip.file("manifest.json")!.async("string")).collection_coverage_confirmed).toBe(true);
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  expect(await page.evaluate(async () => (await window.opTest.loadWeeklyDraft())?.pendingExport)).toBeNull();
});

test("a failed collection never triggers an automatic ZIP", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/local-api/refresh", (route) => {
    state.refresh = { ...state.refresh, job_id: "failed-job", running: true, started_at: "2026-09-11T12:00:00+08:00" };
    return route.fulfill({ json: state.refresh });
  });
  await page.route("**/local-api/refresh/status", (route) => {
    state.refresh = { ...state.refresh, running: false, return_code: 1, outcome: "partial" };
    return route.fulfill({ json: state.refresh });
  });
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "采集并导出 ZIP", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("采集未完整完成");
  expect(downloads).toBe(0);
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeEnabled();
});

test("pending automatic export resumes after reopening using the original dates", async ({ page }) => {
  const state = await setup(page);
  state.refresh = { ...state.refresh, job_id: "reopened-job", running: false, outcome: "complete", return_code: 0, start_date: "2026-09-01", end_date: "2026-09-02", mp_ids: [feed.id, otherFeed.id] };
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "快速排版", exact: true }).click();
  await page.evaluate(async () => {
    const weekly = (await window.opTest.loadWeeklyDraft())!;
    await window.opTest.saveWeeklyDraft({ ...weekly, pendingExport: { jobId: "reopened-job", startDate: "2026-09-01", endDate: "2026-09-02" } });
  });
  const downloading = page.waitForEvent("download");
  await page.reload();
  await page.getByRole("button", { name: "周报", exact: true }).click();
  expect((await downloading).suggestedFilename()).toContain("2026-09-01_2026-09-02");
});

test("stopping packaging aborts requests and preserves imported copy", async ({ page }) => {
  await setup(page);
  await importCopy(page, "# 保留文案");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/local-api/articles/*", async (route) => {
    await held;
    await route.fulfill({ json: { article: { ...article("first"), content: "<p>迟到正文</p>" } } }).catch(() => {});
  });
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "导出已有推文 ZIP", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止打包", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止打包", exact: true }).click();
  release();
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeEnabled();
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 保留文案");
  await expect(page.getByRole("button", { name: "再次下载 ZIP", exact: true })).toHaveCount(0);
  expect(downloads).toBe(0);
});

test("Markdown import and reopen preserve exact bytes without parsing content or calling a model", async ({ page }) => {
  await setup(page);
  let modelCalls = 0;
  await page.route("**/local-api/agent/plan", (route) => { modelCalls++; return route.fulfill({ status: 500, json: {} }); });
  await importCopy(page);
  await expect(page.getByLabel("周报文案原文")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeDisabled();
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  const saved = await page.evaluate(async () => window.opTest.loadWeeklyDraft());
  expect(saved!.preparedCopy!.text).toBe(text);
  expect(saved!.preparedCopy!.format).toBe("markdown");
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByLabel("周报文案原文")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文案原文", exact: true }).click();
  expect(await readFile(await (await downloading).path())).toEqual(Buffer.from(text, "utf8"));
  expect(await page.evaluate(() => (window as Window & { importExecuted?: boolean }).importExecuted)).toBeUndefined();
  expect(modelCalls).toBe(0);
  await page.screenshot({ path: "test-results/weekly-copy-import.png", animations: "disabled" });
});

test("import works without RSS and invalid files preserve the previously imported copy", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/status", (route) => route.fulfill({ json: { protocol: "opslion-rss/v1", available: false, feeds: [], totals: {} } }));
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await importCopy(page, "# 已处理的文案\n\n按模板填写");
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 已处理的文案\n\n按模板填写");
  await importCopy(page, "invalid", "原始资料.zip");
  await expect(page.getByRole("alert")).toContainText("请选择 Markdown");
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 已处理的文案\n\n按模板填写");
  await importCopy(page, "  ", "空.md");
  await expect(page.getByRole("alert")).toContainText("文案文件为空");
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeDisabled();
});

test("reconnecting after configuration changes enables RSS and version mismatch preserves copy", async ({ page }) => {
  await mockBridge(page);
  let available = false;
  let protocol = "opslion-rss/v1";
  await page.route("**/local-api/status", (route) => route.fulfill({ json: { protocol, available, feeds: [feed], totals: {} } }));
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByText("尚未接入 RSS", { exact: true })).toBeVisible();
  await importCopy(page, "# 已有文案");
  available = true;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByText("已接入 · 1 个公众号", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "管理公众号", exact: true })).toBeDisabled();
  await expect(page.getByText("当前适配程序未提供公众号管理，请在 RSS 模块中完成授权与订阅。")).toBeVisible();
  protocol = "old-rss/v0";
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("RSS 协议不兼容");
  await expect(page.getByRole("button", { name: "采集并导出 ZIP", exact: true })).toBeDisabled();
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 已有文案");
});

test("date validation blocks collection and cancelling a running job preserves the imported copy", async ({ page }) => {
  const state = await setup(page);
  await importCopy(page, "# 保留原文");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-08-31");
  await expect(page.getByRole("button", { name: "采集并导出 ZIP", exact: true })).toBeDisabled();
  await expect(page.getByText("开始日期不能晚于结束日期", { exact: true })).toBeVisible();
  await page.getByLabel("结束日期", { exact: true }).fill("2026-09-02");
  await page.route("**/local-api/refresh", (route) => {
    state.refresh = { ...state.refresh, job_id: "cancelled-job", running: true };
    return route.fulfill({ json: state.refresh });
  });
  await page.route("**/local-api/refresh/cancel", (route) => {
    expect(route.request().postDataJSON()).toEqual({ job_id: "cancelled-job" });
    state.refresh = { ...state.refresh, running: false, return_code: 1, outcome: "cancelled" };
    return route.fulfill({ json: state.refresh });
  });
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "采集并导出 ZIP", exact: true }).click();
  await expect(page.getByLabel("开始日期", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "停止采集", exact: true }).click();
  await expect(page.getByText("已请求停止采集，已采集推文和导入文案均保留。")).toBeVisible();
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeEnabled();
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 保留原文");
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  expect((await page.evaluate(() => window.opTest.loadWeeklyDraft()))?.pendingExport).toBeNull();
  expect(downloads).toBe(0);
});

test("a lost pending job is reported without exporting a later task or losing the copy", async ({ page }) => {
  const state = await setup(page);
  await importCopy(page, "# 已保存周报");
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "快速排版", exact: true }).click();
  await page.evaluate(async () => {
    const draft = (await window.opTest.loadWeeklyDraft())!;
    await window.opTest.saveWeeklyDraft({ ...draft, pendingExport: { jobId: "lost-job", startDate: "2026-09-01", endDate: "2026-09-02" } });
  });
  state.refresh = { ...state.refresh, job_id: "newer-job", return_code: 0, outcome: "complete" };
  let downloads = 0; page.on("download", () => downloads++);
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("任务已丢失或被后续任务替代");
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 已保存周报");
  await expect(page.getByRole("button", { name: "导出已有推文 ZIP", exact: true })).toBeEnabled();
  expect(downloads).toBe(0);
});
