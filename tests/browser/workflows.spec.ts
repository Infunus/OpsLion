import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ready, mockBridge, saved } from "./helpers";

test("DOCX import retains its text and embedded image in downloaded HTML", async ({ page }) => {
  await mockBridge(page); await ready(page);
  await page.locator('input[accept^=".docx"]').setInputFiles("tests/fixtures/article.docx");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toHaveText("回归测试文章");
  await expect(page.locator(".preview-content img")).toHaveCount(1);
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /^下载独立 HTML/ }).click();
  const html = await readFile(await (await downloading).path(), "utf8");
  expect(html).toContain("回归测试文章"); expect(html).toContain("这是合成文档中的正文"); expect(html).toContain("data:image/png;base64,");
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "导出到秀米", exact: true })).toBeFocused();
});

test("template slots, image and link survive refresh and Bridge export", async ({ page }) => {
  await mockBridge(page); await ready(page);
  await page.getByRole("button", { name: "样式复刻", exact: true }).click();
  await page.getByRole("textbox", { name: "HTML / 富文本源码" }).fill('<section style="padding:12px"><h2>原始标题</h2><p>原始正文</p><img src="https://example.test/old.png"></section>');
  await page.getByRole("button", { name: "分析结构和替换位" }).click();
  await page.locator(".slot-editor textarea").first().fill("替换后的标题");
  await page.locator(".slot-link-input").first().fill("https://example.test/new");
  await page.locator('.image-slot-editor input[type="text"], .image-slot-editor input:not([type])').first().fill("https://example.test/new.png");
  await expect(page.locator(".preview-content")).toContainText("替换后的标题"); await saved(page);
  await page.reload(); await expect(page.locator(".slot-editor textarea").first()).toHaveValue("替换后的标题");
  await expect(page.locator(".preview-content a").first()).toHaveAttribute("href", "https://example.test/new");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: /^Bridge 数据包/ }).click();
  const data = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
  expect(data.schema).toBe("xiumi-bridge/v3"); expect(data.html).toContain("new.png"); expect(data.html).toContain("https://example.test/new"); expect(data.native.modules.length).toBeGreaterThan(0); expect(data.patch.available).toBe(false); expect(data.patch.reasons.join("；")).toContain("图片已改变");
});

test("mobile layout, preview resize, dark mode and dialog keyboard interaction", async ({ page }) => {
  await mockBridge(page); await ready(page);
  await page.getByRole("slider", { name: "拖动调整预览宽度", exact: true }).press("End");
  await page.getByLabel("调整画布宽度").click();
  await expect(page.getByRole("slider", { name: "画布宽度", exact: true })).toHaveValue("640");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "聚焦预览" }).click(); await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "深色模式" }).click(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "界面动效" })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click(); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "导出到秀米", exact: true })).toBeFocused();
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "实时预览", exact: true }).click();
  await page.getByLabel("调整画布宽度").click();
  await expect(page.getByRole("slider", { name: "画布宽度", exact: true })).toBeVisible();
});

test("model cancellation releases busy UI and discards delayed results", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/agent/plan", async (route) => { await new Promise((resolve) => setTimeout(resolve, 300)); await route.fulfill({ json: { plan: {}, model: "test", latency_ms: 10 } }).catch(() => {}); });
  await ready(page); await expect(page.locator(".agent-status-button")).toContainText("test-model");
  await page.locator(".optional-tools > summary").click();
  await page.getByRole("button", { name: "智能整理", exact: true }).click();
  await page.getByRole("button", { name: "取消模型请求" }).click();
  await expect(page.getByRole("button", { name: "智能整理", exact: true })).toBeEnabled();
  await page.waitForTimeout(400); await expect(page.getByRole("dialog")).toHaveCount(0);
});
