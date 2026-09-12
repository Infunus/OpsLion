import { test, expect } from "@playwright/test";
import { mockBridge, saved } from "./helpers";

test("the actual Vinext route hydrates and restores edits without browser errors", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat|server rendered/i.test(message.text())) errors.push(message.text()); });
  await mockBridge(page);
  const response = await page.goto("http://127.0.0.1:3108");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("真实页面保存测试");
  await saved(page); await page.reload();
  await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toHaveValue("真实页面保存测试");
  await expect(page.locator(".preview-content h1")).toHaveText("真实页面保存测试");
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "深色模式" }).click();
  await page.screenshot({ path: testInfo.outputPath("dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});
