import { test, expect } from "@playwright/test";
import { mockBridge, ready } from "./helpers";

test("a fresh library is empty, imports a user template, and returns to empty after removal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockBridge(page); await ready(page);
  expect(await page.evaluate(() => window.opTest.layoutEngine.builtinTemplates)).toEqual([]);
  await page.getByRole("button", { name: "模板库", exact: true }).click();
  await expect(page.getByText("模板库为空", { exact: true })).toBeVisible();
  await expect(page.locator(".layout-catalog-card")).toHaveCount(0);
  const template = await page.evaluate(() => window.opTest.layoutEngine.testTemplates[0]);
  await page.getByLabel("导入文章模板包文件").setInputFiles({ name: "import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)) });
  await expect(page.getByRole("button", { name: "套用到当前文章", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "移出模板库", exact: true }).click();
  await expect(page.getByText("模板库为空", { exact: true })).toBeVisible();
  await expect(page.locator(".layout-catalog-card")).toHaveCount(0);
  await page.screenshot({ path: "test-results/public-empty-library.png" });
  expect(errors).toEqual([]);
});

test("weekly copy import is independent of collection services and rejected files preserve the saved copy", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (/local-api\/(?:articles|refresh|legacy|rss|agent\/plan)/.test(request.url())) requests.push(request.url()); });
  await mockBridge(page); await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByRole("button", { name: "采集正文并打包", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /公众号与登录/ })).toBeEnabled();
  const copy = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekStarter);
  const input = page.getByLabel("导入周报文案文件");
  await input.setInputFiles({ name: "weekly.md", mimeType: "text/markdown", buffer: Buffer.from(copy) });
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeEnabled();
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  await input.setInputFiles({ name: "empty.md", mimeType: "text/markdown", buffer: Buffer.from("") });
  await expect(page.getByRole("alert")).toContainText("文案文件为空");
  await expect(page.getByLabel("周报文案原文")).toHaveValue(copy);
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByLabel("周报文案原文")).toHaveValue(copy);
  expect(requests).toEqual([]);
});
