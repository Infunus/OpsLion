import { test, expect, type Page } from "@playwright/test";
import { mockBridge, ready } from "./helpers";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.setItem("opslion-weekly-source", "rss")); });

const initialFeed = { id: "synthetic", mp_name: "校园资讯", alias: "campus-news", status: 1, article_count: 2, update_time: 0, url_count: 2 };
const expired = { state: "expired", authenticated: false, message: "授权已过期，请重新扫码" };
const authorized = { state: "authorized", authenticated: true, message: "公众号已授权" };
const qr = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
async function setup(page: Page) {
  await mockBridge(page);
  const state = { auth: { ...expired }, feeds: [{ ...initialFeed }], collecting: false };
  await page.route("**/local-api/status", (route) => route.fulfill({ json: { protocol: "opslion-rss/v1", management_version: 1, available: true, ...state, totals: {} } }));
  await page.route("**/local-api/rss/management", (route) => route.fulfill({ json: state }));
  await page.route("**/local-api/rss/feeds/update", (route) => {
    const { id, action } = route.request().postDataJSON();
    state.feeds = action === "remove" ? state.feeds.filter((feed) => feed.id !== id) : state.feeds.map((feed) => feed.id === id ? { ...feed, status: action === "pause" ? 0 : 1 } : feed);
    return route.fulfill({ json: { ok: true } });
  });
  await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
  return state;
}
const open = (page: Page) => page.getByRole("button", { name: "管理公众号", exact: true }).click();

test("scan confirmation immediately updates authorization and clearing it preserves the weekly draft", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("导入周报文案文件").setInputFiles({ name: "本期.md", mimeType: "text/markdown", buffer: Buffer.from("# 保留这份周报文案") });
  let polls = 0;
  await page.route("**/local-api/rss/auth/start", (route) => route.fulfill({ json: { state: "waiting", session_id: "a".repeat(32), qr_data_url: qr } }));
  await page.route("**/local-api/rss/auth/poll?**", (route) => {
    polls += 1;
    if (polls === 1) return route.fulfill({ json: { state: "scanned" } });
    state.auth = { ...authorized };
    return route.fulfill({ json: { state: "authorized", auth: state.auth } });
  });
  await page.route("**/local-api/rss/auth/logout", (route) => {
    state.auth = { state: "logged_out", authenticated: false, message: "尚未授权" };
    return route.fulfill({ json: state.auth });
  });
  await open(page);
  const dialog = page.getByRole("dialog", { name: "公众号与授权" });
  await expect(dialog.getByText("已过期", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "扫码授权", exact: true }).click();
  await expect(dialog.getByAltText("微信公众号授权二维码")).toBeVisible();
  await expect(dialog.getByText("已扫码，请在手机上确认")).toBeVisible();
  await expect(dialog.getByText("已授权", { exact: true })).toBeVisible();
  await expect(dialog.getByAltText("微信公众号授权二维码")).toHaveCount(0);
  await dialog.getByRole("button", { name: "清除本机授权" }).click();
  await expect(dialog.getByText("未授权", { exact: true })).toBeVisible();
  await expect(dialog.getByText("校园资讯", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭公众号管理" }).click();
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 保留这份周报文案");
});

test("article link identity is previewed before subscribing, and duplicate subscriptions are disabled", async ({ page }) => {
  const state = await setup(page);
  const candidate = { candidate_id: "candidate", mp_name: "学生生活", alias: "student-life", article_title: "新学期活动安排", subscribed: false };
  let adds = 0;
  await page.route("**/local-api/rss/feeds/resolve", (route) => {
    expect(route.request().postDataJSON()).toEqual({ url: "https://mp.weixin.qq.com/s/synthetic" });
    return route.fulfill({ json: { ...candidate, subscribed: adds > 0 } });
  });
  await page.route("**/local-api/rss/feeds/add", (route) => {
    expect(route.request().postDataJSON()).toEqual({ candidate_id: "candidate" });
    adds += 1;
    state.feeds.push({ ...initialFeed, id: "new", mp_name: candidate.mp_name, alias: candidate.alias, article_count: 0 });
    return route.fulfill({ json: { ok: true, already_subscribed: false } });
  });
  await open(page);
  await page.getByLabel("通过推文链接添加").fill("https://mp.weixin.qq.com/s/synthetic");
  await page.getByRole("button", { name: "识别公众号", exact: true }).click();
  await expect(page.locator(".rss-candidate")).toContainText("学生生活");
  await expect(page.locator(".rss-candidate")).toContainText("新学期活动安排");
  expect(adds).toBe(0);
  await page.getByRole("button", { name: "添加订阅", exact: true }).click();
  await expect(page.locator(".rss-subscriptions")).toContainText("学生生活");
  await expect(page.getByLabel("通过推文链接添加")).toHaveValue("");
  await page.getByLabel("通过推文链接添加").fill("https://mp.weixin.qq.com/s/synthetic");
  await page.getByRole("button", { name: "识别公众号", exact: true }).click();
  await expect(page.getByRole("button", { name: "已订阅", exact: true })).toBeDisabled();
  expect(adds).toBe(1);
  await page.getByRole("button", { name: "关闭公众号管理" }).click();
  await expect(page.getByText("已接入 · 2 个公众号", { exact: true })).toBeVisible();
});

test("subscriptions can be searched, paused, resumed and removed without changing imported copy", async ({ page }) => {
  await setup(page);
  await page.getByLabel("导入周报文案文件").setInputFiles({ name: "保留.md", mimeType: "text/markdown", buffer: Buffer.from("# 保留文案") });
  await open(page);
  await page.getByLabel("搜索已订阅公众号").fill("no-match");
  await expect(page.getByText("没有匹配的订阅")).toBeVisible();
  await page.getByLabel("搜索已订阅公众号").fill("campus");
  await page.getByRole("button", { name: "暂停 校园资讯", exact: true }).click();
  await expect(page.locator(".rss-subscriptions").getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复 校园资讯", exact: true }).click();
  await expect(page.locator(".rss-subscriptions").getByText("已启用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "移除 校园资讯", exact: true }).click();
  await expect(page.getByText("订阅已移除，已采集文章保留；再次添加链接可恢复订阅")).toBeVisible();
  await page.getByRole("button", { name: "关闭公众号管理" }).click();
  await expect(page.getByText("已接入 · 0 个公众号", { exact: true })).toBeVisible();
  await expect(page.getByLabel("周报文案原文")).toHaveValue("# 保留文案");
});

test("editing the article link discards a stale identity response and a failed resolve stays actionable", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/local-api/rss/feeds/resolve", async (route) => {
    requested = true;
    await held;
    return route.fulfill({ json: { candidate_id: "old", mp_name: "过时结果", subscribed: false } });
  });
  await open(page);
  await page.getByLabel("通过推文链接添加").fill("https://mp.weixin.qq.com/s/old");
  await page.getByRole("button", { name: "识别公众号", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByLabel("通过推文链接添加").fill("https://mp.weixin.qq.com/s/new");
  release();
  await expect(page.getByRole("button", { name: "识别公众号", exact: true })).toBeEnabled();
  await expect(page.locator(".rss-candidate")).toHaveCount(0);
  await page.route("**/local-api/rss/feeds/resolve", (route) => route.fulfill({ status: 400, json: { message: "推文需要验证，请换一篇可正常打开的推文" } }));
  await page.getByRole("button", { name: "识别公众号", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("推文需要验证");
  await expect(page.getByRole("button", { name: "识别公众号", exact: true })).toBeEnabled();
});

test("closing an active QR cancels its session and mobile management fits the viewport", async ({ page }) => {
  await setup(page);
  let cancelled = false;
  await page.route("**/local-api/rss/auth/start", (route) => route.fulfill({ json: { state: "waiting", session_id: "a".repeat(32), qr_data_url: qr } }));
  await page.route("**/local-api/rss/auth/poll?**", (route) => route.fulfill({ json: { state: "waiting" } }));
  await page.route("**/local-api/rss/auth/cancel", (route) => {
    expect(route.request().postDataJSON()).toEqual({ session_id: "a".repeat(32) });
    cancelled = true;
    return route.fulfill({ json: { state: "cancelled" } });
  });
  await open(page);
  expect(await page.getByRole("dialog").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const dialogBounds = await page.getByRole("dialog").boundingBox();
  const headingBounds = await page.getByRole("heading", { name: "公众号与授权", exact: true }).boundingBox();
  expect(headingBounds!.x).toBeGreaterThan(dialogBounds!.x);
  await page.screenshot({ path: "test-results/rss-management-desktop.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: "test-results/rss-management-dark.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator(".rss-manager").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.locator(".rss-manager").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/rss-management-mobile.png", animations: "disabled" });
  await page.getByRole("button", { name: "扫码授权", exact: true }).click();
  await expect(page.getByAltText("微信公众号授权二维码")).toBeVisible();
  await page.getByRole("button", { name: "关闭公众号管理" }).click();
  await expect.poll(() => cancelled).toBe(true);
});

test("an active collection locks subscription and authorization mutations", async ({ page }) => {
  const state = await setup(page);
  state.collecting = true;
  await open(page);
  await expect(page.getByText("采集进行中，停止采集后可更改授权和订阅。")).toBeVisible();
  await expect(page.getByRole("button", { name: "扫码授权", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "暂停 校园资讯", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "移除 校园资讯", exact: true })).toBeDisabled();
});
