import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockBridge, ready } from "./helpers";

const header = "<!-- opslion:hello-week/v1 -->\n# 测试周报\n<!-- layout: classic -->\n";
const content = ":::section 本周回顾\n:::\n:::category 学术信息\n:::\n:::news 首条标题\n- 详情请见：[原文标题](https://example.com/one?a=1&b=2)\n:::\n:::news 次条标题\n- 详情请见：[另一原文](https://example.com/two)\n:::\n:::notice 重要提示标题\n提醒内容\n:::\n:::divider\n:::\n:::code-outro\n:::\n:::footer\n:::";
const settings = { email: "weekly@example.com", contactPerson: "测试联系人（公开联系渠道）", organization: "测试组织" };

test("headings, links and dividers retain exact typography in preview and native Bridge HTML", async ({ page }) => {
  await ready(page, true);
  const data = await page.evaluate(async ({ copy, settings }) => {
    const api = window.opTest.weeklyTemplate;
    const rendered = api.renderHelloWeek(copy, settings);
    const packet = await api.createWeeklyBridgePackage(rendered.html, rendered.title);
    return { html: rendered.html, native: packet.native.modules.map((module) => module.html).join("") };
  }, { copy: header + content, settings });
  for (const html of [data.html, data.native]) {
    await page.setContent(`<style>body{margin:0}h3{font-size:24px!important;font-weight:400!important}article{width:390px;max-width:100%;font-size:14px}</style><article>${html}</article>`);
    for (const title of ["首条标题", "次条标题", "重要提示标题"]) {
      const heading = page.locator("strong").filter({ hasText: new RegExp(`^${title}$`) });
      await expect(heading).toHaveCSS("font-size", "16px");
      await expect(heading).toHaveCSS("font-weight", "700");
      await expect(heading).toHaveCSS("color", "rgb(255, 255, 255)");
    }
    for (const link of await page.locator("a").all()) await expect(link).toHaveCSS("text-decoration-line", "none");
    const divider = page.locator("strong").filter({ hasText: /^＞＞＞-/ });
    await expect(divider).toHaveCSS("font-size", "16px");
    await expect(divider).toHaveCSS("font-weight", "700");
    await expect(divider).toHaveCSS("color", "rgb(0, 0, 0)");
    for (const text of ["测试组织", "文案丨", "排版丨", "校对丨", "对于学生会组织建设和活动开展的意见和建议", "需要学生会帮助解决的权益诉求"]) await expect(page.getByText(text, { exact: true })).toHaveCSS("font-weight", "700");
    for (const width of [375, 390, 414]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test("fixed blocks are inserted once, legacy generated names are discarded and old HTML upgrades idempotently", async ({ page }) => {
  await ready(page, true);
  const legacy = "\n:::contact 旧联系区\n旧联系方式\n:::\n:::credits 旧组织\n文案丨旧作者\n排版丨旧排版\n校对丨旧校对\n:::";
  const result = await page.evaluate(({ copy, legacy, settings }) => {
    const api = window.opTest.weeklyTemplate;
    const current = api.renderHelloWeek(copy, settings);
    const fromLegacy = api.renderHelloWeek(copy + legacy, settings);
    const holder = document.createElement("div"); holder.innerHTML = fromLegacy.html;
    const title = holder.querySelector('[data-layout-module="weekly-news"] > section > p')!;
    title.outerHTML = `<h3 style="font-size:24px;font-weight:400;background:#89b1e6;color:#fff">${title.textContent}</h3>`;
    const updated = api.applyHelloWeekTemplate(holder.innerHTML, settings);
    return { current: current.html, fromLegacy: fromLegacy.html, updated, twice: api.applyHelloWeekTemplate(updated, settings), emptyMarkers: api.renderHelloWeek(copy + "\n:::contact\n:::\n:::credits\n:::", settings).html };
  }, { copy: header + content, legacy, settings });
  expect(result.current).toBe(result.fromLegacy);
  expect(result.current).toBe(result.emptyMarkers);
  expect(result.updated).toBe(result.twice);
  expect(result.updated).not.toMatch(/旧联系方式|旧作者|旧排版|旧校对|旧组织/);
  await page.setContent(result.updated);
  for (const kind of ["contact", "credits"]) await expect(page.locator(`[data-layout-module="weekly-${kind}"]`)).toHaveCount(1);
  await expect(page.locator('[data-layout-module="weekly-contact"]')).toContainText(settings.contactPerson);
  await expect(page.locator('[data-layout-module="weekly-credits"] p')).toHaveText([settings.organization, "文案丨", "排版丨", "校对丨"]);
  const order = await page.locator("[data-layout-module]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-layout-module")));
  expect(order.indexOf("weekly-contact")).toBeLessThan(order.indexOf("weekly-code-outro"));
  expect(order.indexOf("weekly-credits")).toBeLessThan(order.indexOf("weekly-footer"));
});

test("one-time local settings control preview and export without changing imported copy", async ({ page }) => {
  await mockBridge(page);
  let saved = { email: "", contactPerson: "", organization: "" };
  await page.route("**/local-api/weekly/template-settings", (route) => {
    if (route.request().method() === "POST") saved = route.request().postDataJSON();
    return route.fulfill({ json: { settings: saved } });
  });
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  const copy = header + content;
  await page.getByLabel("导入周报文案文件").setInputFiles({ name: "test.md", mimeType: "text/markdown", buffer: Buffer.from(copy) });
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "模板固定信息", exact: true }).click();
  await page.getByLabel("落款组织", { exact: true }).fill(settings.organization);
  await page.getByLabel("学生会公共邮箱", { exact: true }).fill(settings.email);
  await page.getByLabel("学生会负责人及联系方式", { exact: true }).fill(settings.contactPerson);
  await page.getByRole("button", { name: "保存固定信息", exact: true }).click();
  await expect(page.locator('.hello-week-paper [data-layout-module="weekly-contact"]')).toContainText(settings.email);
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeEnabled();
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByLabel("周报文案原文")).toHaveValue(copy);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Bridge 包", exact: true }).click();
  const packet = JSON.parse(await readFile(await (await downloadPromise).path(), "utf8"));
  expect(packet.plainText).toContain(settings.email);
  expect(packet.plainText).toContain(settings.contactPerson);
  expect(packet.plainText).toContain("校对丨");
  expect(saved).toEqual(settings);
});

test("unreadable local settings block export and can be recovered by saving again", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/weekly/template-settings", (route) => route.request().method() === "GET" ? route.fulfill({ status: 500, json: { message: "本机周报固定信息无法读取" } }) : route.fulfill({ json: { settings: route.request().postDataJSON() } }));
  await ready(page); await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByLabel("导入周报文案文件").setInputFiles({ name: "test.md", mimeType: "text/markdown", buffer: Buffer.from(header + content) });
  await expect(page.getByRole("alert")).toContainText("无法读取");
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "模板固定信息", exact: true }).click();
  await page.getByLabel("落款组织", { exact: true }).fill(settings.organization);
  await page.getByLabel("学生会公共邮箱", { exact: true }).fill(settings.email);
  await page.getByLabel("学生会负责人及联系方式", { exact: true }).fill(settings.contactPerson);
  await page.getByRole("button", { name: "保存固定信息", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeEnabled();
});
