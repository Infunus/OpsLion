import { test, expect } from "@playwright/test";
import { mockBridge, ready } from "./helpers";
import { VERIFICATION_PROBE_JS } from "../../scripts/collector-verification.mjs";
import { LOGIN_PROBE_JS } from "../../scripts/collector-auth.mjs";
import { buildContentJs } from "../../scripts/weread-content.mjs";

const account = { name: "示例公众号", bookId: "MP_WXS_123", enabled: true };
const archive = { id: "a".repeat(24), start_date: "2026-09-07", end_date: "2026-09-13", article_count: 2, body_count: 2, image_count: 3, complete: true, size: 204800, issues: [] as { type: string; message: string }[] };
const base = { protocol: "opslion-collector/v1", prepared: true, module_available: true, node_available: true, browser_available: true, session: { state: "ready", message: "已登录微信读书。" }, accounts: [account], has_index: true, quota: { used: 8, max: 40, runs: 1, max_runs: 2 }, job: null, exports: [] };

test("只识别可见验证，验证成功后隐藏的节点不再阻止登录", async ({ page }) => {
  await page.route("https://weread.qq.com/**", (route) => route.fulfill({ contentType: "text/html", body: '<div id="challenge" style="opacity:0"><div id="tcaptcha_wrapper_transform_dy" style="width:200px;height:150px">验证组件</div></div>' }));
  await page.goto("https://weread.qq.com/");
  await page.context().addCookies([{ name: "wr_vid", value: "123", url: "https://weread.qq.com/" }]);
  expect(await page.evaluate(VERIFICATION_PROBE_JS)).toBe(false);
  expect(await page.evaluate(LOGIN_PROBE_JS)).toMatchObject({ state: "ready" });
  await page.locator("#challenge").evaluate((node) => { (node as HTMLElement).style.opacity = "1"; });
  expect(await page.evaluate(VERIFICATION_PROBE_JS)).toBe(true);
  expect(await page.evaluate(LOGIN_PROBE_JS)).toMatchObject({ state: "verification" });
});

test("正文验证响应触发交接，权限错误和普通正文不误报验证", async ({ page }) => {
  let body = "当前环境异常，完成验证后即可继续访问";
  await page.route("https://weread.qq.com/**", (route) => route.fulfill({ contentType: "text/html", body: route.request().url().includes("/content?") ? body : "阅读页面" }));
  await page.goto("https://weread.qq.com/web/mp/reader/example");
  const fetchBody = async () => JSON.parse(await page.evaluate(buildContentJs("MP_WXS_123_demo")));
  expect(await fetchBody()).toMatchObject({ code: "verification" });
  body = "你暂无权限查看此页面内容";
  expect(await fetchBody()).toMatchObject({ code: "permission_denied" });
  body = '<div id="js_content">文章讨论：请完成人机验证</div>';
  expect(await fetchBody()).toMatchObject({ ok: true });
});

test("浏览器验证提示保留续传入口，刷新页面不重复请求弹窗", async ({ page }) => {
  await mockBridge(page);
  const job = { id: "verify", action: "collect", state: "paused", stage: "verification", completed: 1, total: 3, message: "已自动打开默认浏览器，请在窗口中完成验证后继续上次任务。", result: { code: "verification", browser_opened: true } };
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: { ...base, job, resume_job: job, session: { state: "verification", message: job.message } } }));
  const actions: string[] = [];
  await page.route("**/local-api/collector/actions", (route) => { actions.push(route.request().postDataJSON().action); return route.fulfill({ json: { job_id: "retry" } }); });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByText(job.message, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续上次任务" })).toBeEnabled();
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新打开验证页面" })).toBeVisible();
  expect(actions).toEqual([]);
  await page.getByRole("button", { name: "继续上次任务" }).click();
  expect(actions).toEqual(["resume"]);
});

test("全新安装从前端初始化和添加公众号，不调用原版 RSS", async ({ page }) => {
  await mockBridge(page);
  let state = { ...base, prepared: false, accounts: [] as typeof base.accounts, session: { state: "unknown", message: "尚未登录" } };
  let rssRequests = 0;
  await page.route("**/local-api/status", (route) => { rssRequests++; return route.fulfill({ json: {} }); });
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: state }));
  await page.route("**/local-api/collector/actions", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "initialize") state = { ...state, prepared: true };
    if (body.action === "check") state = { ...state, session: { state: "ready", message: "已登录微信读书。" } };
    if (body.action === "resolve") { expect(body.url).toBe("https://mp.weixin.qq.com/s/example"); state = { ...state, accounts: [account] }; }
    return route.fulfill({ status: 202, json: { job_id: "test" } });
  });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByRole("button", { name: "初始化采集环境" }).click();
  await expect(page.getByRole("button", { name: "添加公众号", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加公众号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "公众号与登录" });
  await dialog.getByRole("button", { name: "扫码登录", exact: true }).click();
  await dialog.getByRole("button", { name: "检查登录", exact: true }).click();
  await dialog.getByLabel("公众号文章链接").fill("https://mp.weixin.qq.com/s/example");
  await dialog.getByRole("button", { name: "添加公众号", exact: true }).click();
  await expect(dialog.getByText(account.name, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(rssRequests).toBe(0);
  await page.screenshot({ path: "test-results/collector-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /公众号与登录/ }).click();
  expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/collector-mobile-manager.png", fullPage: true, animations: "disabled" });
});

test("前端显示真实任务、重开继续跟踪、暂停续传和完整下载入口", async ({ page }) => {
  await mockBridge(page);
  let job: Record<string, unknown> | null = null;
  let exports: typeof archive[] = [];
  let starts = 0;
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: { ...base, job, exports } }));
  await page.route("**/local-api/collector/actions", (route) => {
    const input = route.request().postDataJSON();
    starts++;
    if (input.action === "collect") {
      expect(input).toEqual({ action: "collect", start_date: "2026-09-07", end_date: "2026-09-13" });
      job = { id: "job", action: "collect", state: "running", stage: "bodies", message: "正在取得正文", completed: 1, total: 2 };
    } else { expect(input).toEqual({ action: "resume", job_id: "job" }); job = { ...job, state: "complete", message: "已取得两篇正文" }; exports = [archive]; }
    return route.fulfill({ status: 202, json: { job_id: "job" } });
  });
  await page.route("**/local-api/collector/cancel", (route) => { job = { ...job, state: "cancelled", message: "已停止，缓存保留" }; return route.fulfill({ json: { ok: true } }); });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-09-07"); await page.getByLabel("结束日期", { exact: true }).fill("2026-09-13");
  await page.getByRole("button", { name: "采集正文并打包" }).click();
  await expect(page.getByRole("button", { name: "采集正文并打包" })).toBeDisabled();
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByText("正在取得正文", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止任务" }).click();
  await page.getByRole("button", { name: "继续上次任务" }).click();
  await expect(page.getByRole("link", { name: "下载资料 ZIP", exact: true })).toHaveAttribute("href", `/local-api/collector/download?id=${archive.id}&kind=zip`);
  await expect(page.getByRole("link", { name: "下载纯文字" })).toBeVisible();
  expect(starts).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/collector-mobile.png", fullPage: true });
});

test("缺失项可见、非法日期禁用采集，采集不覆盖导入文案", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: { ...base, exports: [{ ...archive, complete: false, body_count: 1, issues: [{ type: "body", message: "第二篇正文尚未取得" }] }] } }));
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  const copy = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekStarter);
  await page.getByLabel("导入周报文案文件").setInputFiles({ name: "本期.md", mimeType: "text/markdown", buffer: Buffer.from(copy) });
  await expect(page.getByLabel("周报文案原文")).toHaveValue(copy);
  await expect(page.getByRole("link", { name: "下载资料 ZIP", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载现有资料 ZIP" })).toBeVisible();
  await page.getByText("查看缺失清单", { exact: true }).click();
  await expect(page.getByText("第二篇正文尚未取得", { exact: true })).toBeVisible();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-10"); await page.getByLabel("结束日期", { exact: true }).fill("2026-09-01");
  await expect(page.getByRole("button", { name: "采集正文并打包" })).toBeDisabled();
});

test("重新检查登录后仍能继续此前暂停的采集", async ({ page }) => {
  await mockBridge(page);
  const work = { id: "paused-collection", action: "collect", state: "paused", message: "登录需检查", stage: "bodies", completed: 1, total: 2 };
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: { ...base, job: { ...work, id: "login-check", action: "check", state: "complete", message: "登录有效" }, resume_job: work } }));
  let requested = false;
  await page.route("**/local-api/collector/actions", (route) => { expect(route.request().postDataJSON()).toEqual({ action: "resume", job_id: work.id }); requested = true; return route.fulfill({ status: 202, json: { job_id: "resumed" } }); });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByRole("button", { name: "继续上次任务" }).click();
  expect(requested).toBe(true);
});

test("本机采集额度耗尽时明确提示，缓存导出和下载仍可使用", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/collector/status", (route) => route.fulfill({ json: { ...base, quota: { used: 40, max: 40, runs: 2, max_runs: 2 }, exports: [archive] } }));
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByRole("button", { name: "采集正文并打包" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出已有资料" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "下载资料 ZIP", exact: true })).toBeVisible();
  await expect(page.getByText("本机今日请求预算已用完，明日可继续采集。已有缓存资料仍可导出、下载。", { exact: true })).toBeVisible();
});

test("二维码直接显示、扫码后自动收起，外部登录明确使用默认浏览器", async ({ page }) => {
  await mockBridge(page);
  const id = "b".repeat(32);
  const actions: string[] = [];
  let state: Record<string, unknown> = { ...base, browser_name: "Microsoft Edge", session: { state: "unknown", message: "请扫码" } };
  await page.route("**/local-api/collector/status", route => route.fulfill({ json: state }));
  await page.route("**/local-api/collector/login-qr?**", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=", "base64") }));
  await page.route("**/local-api/collector/actions", route => {
    const { action } = route.request().postDataJSON(); actions.push(action);
    if (action === "login") state = { ...state, job: { id, action, state: "running", message: "等待扫码" }, login: { id, state: "waiting", qr_available: true, revision: 1, expires_at: Date.now() + 300000, message: "请使用微信扫一扫" } };
    return route.fulfill({ status: 202, json: { job_id: id } });
  });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByRole("button", { name: /公众号与登录/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "扫码登录", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "微信读书登录二维码" })).toHaveAttribute("src", `/local-api/collector/login-qr?id=${id}&v=1`);
  await expect(dialog.getByRole("button", { name: "停止扫码" })).toBeEnabled();
  expect(actions).toEqual(["login"]);
  state = { ...state, session: { state: "ready", message: "登录已完成" }, login: { id, state: "ready", qr_available: false, message: "登录已完成" }, job: { id, action: "login", state: "complete", message: "已保存会话" } };
  await expect(dialog.getByRole("img", { name: "微信读书登录二维码" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "用默认浏览器登录或验证" }).click();
  expect(actions).toEqual(["login", "open-browser"]);
});
