import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ready, saved, mockBridge } from "./helpers";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=";
const photo = (name = "photo.png") => ({ name, mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
async function setup(page: Page) {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async () => {
    const api = window.opTest; const project = api.createDefaultProject();
    project.layout = api.layoutEngine.createLayoutState({ schema: "opslion.article/v1", id: project.id, nodes: [
      { id: "title", type: "article_title", content: [{ text: "春日阅读会" }] },
      { id: "a", type: "paragraph", content: [{ text: "第一段原文。", marks: ["bold"] }, { href: "https://example.com/reading", content: [{ text: "活动链接" }] }] },
      { id: "h", type: "heading1", content: [{ text: "活动安排" }] },
      { id: "b", type: "paragraph", content: [{ text: "末段保持原样。" }] },
      { id: "l", type: "ul", items: [{ id: "li", content: [{ text: "原列表项目" }] }] },
    ] }, api.layoutEngine.testTemplates[1]);
    project.content = api.layoutEngine.articleToLegacyContent(project.layout.article);
    await api.saveProject(project);
  });
  await ready(page); await expect(page.locator('.editable-article [data-op-source="a"][data-op-field]')).toBeVisible();
}
test("canvas text edits persist, preserve untouched rich text, and never export editor controls", async ({ page }) => {
  await setup(page);
  const field = page.locator('.editable-article [data-op-source="b"][data-op-field="content"]');
  await field.fill("直接编辑画布里的中文正文。"); await field.press("End"); await field.pressSequentially("继续输入ABC");
  await expect(field).toHaveText("直接编辑画布里的中文正文。继续输入ABC");
  await expect(page.getByRole("textbox", { name: "第 3 项内容", exact: true })).toHaveText("直接编辑画布里的中文正文。继续输入ABC");
  await page.locator('.editable-article [data-op-source="li"][data-op-field]').fill("列表也可直接编辑");
  const mode = page.getByRole("group", { name: "画布模式", exact: true });
  await mode.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "画布编辑工具", exact: true })).toHaveCount(0);
  await expect(page.locator(".preview-content")).toContainText("列表也可直接编辑");
  await expect(page.locator(".preview-content a")).toHaveAttribute("href", "https://example.com/reading");
  await mode.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(field).toHaveText("直接编辑画布里的中文正文。继续输入ABC");
  await page.getByRole("button", { name: "撤销编辑", exact: true }).click();
  await expect(page.locator('.editable-article [data-op-source="li"][data-op-field]')).toHaveText("原列表项目");
  await page.getByRole("button", { name: "重做编辑", exact: true }).click();
  await saved(page); await page.reload(); await saved(page);
  await expect(page.locator('.editable-article [data-op-source="b"][data-op-field]')).toContainText("继续输入ABC");
  await expect(page.locator('.editable-article [data-op-source="a"] strong')).toHaveText("第一段原文。");
  await expect(page.locator('.editable-article [data-op-source="a"] a')).toHaveAttribute("href", "https://example.com/reading");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: /^下载独立 HTML/ }).click();
  const html = await readFile((await (await download).path())!, "utf8");
  expect(html).toContain("继续输入ABC"); expect(html).toContain("列表也可直接编辑"); expect(html).not.toMatch(/data-op-|contenteditable|点击输入文字|画布编辑工具/);
});

test("template modules insert at selection, collapse and reopen, and deletion supports undo and redo", async ({ page }, testInfo) => {
  await setup(page);
  await page.locator('.editable-article [data-op-source="a"][data-op-field]').click();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click();
  await expect(page.getByRole("button", { name: "插入章节卡片模块" })).toBeVisible();
  await page.getByRole("button", { name: "插入分割线模块", exact: true }).click();
  await expect(page.locator(".editable-article hr")).toHaveCount(1);
  await page.getByRole("button", { name: "画布删除模块", exact: true }).click(); await expect(page.locator(".editable-article hr")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销编辑", exact: true }).click(); await expect(page.locator(".editable-article hr")).toHaveCount(1);
  await page.getByRole("button", { name: "重做编辑", exact: true }).click(); await expect(page.locator(".editable-article hr")).toHaveCount(0);
  await page.locator('.editable-article [data-op-source="b"][data-op-field]').click();
  await page.getByLabel("模块插入位置", { exact: true }).selectOption("before");
  await page.getByRole("button", { name: "插入正文模块", exact: true }).click();
  const added = page.locator('.editable-article [data-op-field="content"][contenteditable="true"]').filter({ hasText: /^$/ });
  await expect(added).toHaveCount(1); await added.fill("插在末段之前的新正文"); await saved(page);
  const nodes = await page.evaluate(async () => (await window.opTest.loadActiveProject())!.layout!.article.nodes);
  const index = nodes.findIndex((node) => node.id === "b"); expect(nodes[index - 1]).toMatchObject({ type: "paragraph", content: [{ text: "插在末段之前的新正文" }] });
  await page.getByRole("button", { name: "收起模块边栏", exact: true }).click(); await expect(page.locator(".template-module-sidebar")).toBeHidden();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click(); await expect(page.locator(".template-module-sidebar")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("canvas-desktop.png"), animations: "disabled" });
});

test("image modules bind local files at the chosen position and captions remain editable", async ({ page }) => {
  await setup(page);
  await page.locator('.editable-article [data-op-source="a"][data-op-field]').click();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click();
  await page.getByRole("button", { name: "插入双图模块", exact: true }).click();
  await page.getByLabel("画布插入图片文件", { exact: true }).setInputFiles([photo("one.png"), photo("two.png")]);
  await expect(page.locator(".editable-article img")).toHaveCount(2);
  await page.locator(".editable-article img").first().click();
  await page.locator('.editable-article [data-op-field="caption"]').first().fill("第一张图的说明");
  await saved(page);
  const nodes = await page.evaluate(async () => (await window.opTest.loadActiveProject())!.layout!.article.nodes);
  expect(nodes.map((n) => n.type)).toEqual(["article_title", "paragraph", "image", "image", "heading1", "paragraph", "ul"]);
  expect(nodes[2]).toMatchObject({ caption: [{ text: "第一张图的说明" }] });
  await page.locator(".editable-article img").first().dblclick(); await page.getByLabel("画布插入图片文件", { exact: true }).setInputFiles(photo("replacement.png"));
  await expect(page.locator('.editable-article [data-op-field="caption"]').first()).toHaveText("第一张图的说明");
  await page.getByRole("group", { name: "画布模式", exact: true }).getByRole("button", { name: "预览", exact: true }).click(); await expect(page.locator(".preview-content [contenteditable]")).toHaveCount(0);
  await expect(page.locator(".preview-content img")).toHaveCount(2);
  await page.getByRole("button", { name: "插入正文模块", exact: true }).click();
  await expect(page.locator('.editable-article [data-op-field="content"]').filter({ hasText: /^$/ })).toBeFocused();
});

test("mobile module insertion, Chinese composition and read-only preview remain usable", async ({ page }, testInfo) => {
  await setup(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "实时预览", exact: true }).click();
  const field = page.locator('.editable-article [data-op-source="b"][data-op-field]');
  await field.click(); await field.dispatchEvent("compositionstart"); await field.fill("拼音组合中的中文");
  await field.dispatchEvent("compositionend"); await saved(page);
  await expect(field).toHaveText("拼音组合中的中文");
  const mode = page.getByRole("group", { name: "画布模式", exact: true });
  await mode.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".preview-content [contenteditable]")).toHaveCount(0);
  await expect(page.locator(".preview-content")).toContainText("拼音组合中的中文");
  await mode.getByRole("button", { name: "预览", exact: true }).press("Tab");
  await expect(mode.getByRole("button", { name: "编辑", exact: true })).toBeFocused();
  await mode.getByRole("button", { name: "编辑", exact: true }).press("Enter");
  await expect(field).toHaveText("拼音组合中的中文");
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click();
  await page.getByLabel("搜索模板模块").fill("引用"); await expect(page.locator(".template-module-card")).toHaveCount(1);
  await page.getByRole("button", { name: "插入引用模块", exact: true }).click();
  await expect(page.locator('.editable-article blockquote [data-op-field]')).toBeFocused(); await page.locator('.editable-article blockquote [data-op-field]').fill("刚刚插入的一段引用。");
  await expect(page.locator(".preview-stage")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("canvas-mobile.png"), animations: "disabled" });
});
