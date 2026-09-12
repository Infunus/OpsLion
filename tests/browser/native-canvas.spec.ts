import { test, expect, type Page } from "@playwright/test";
import { ready, saved, mockBridge } from "./helpers";
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=";
async function setup(page: Page) {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async (src) => {
    const api = window.opTest; const project = api.createDefaultProject(); project.mode = "clone";
    project.cloneTemplate = api.analyzeTemplateHtml(`<section style="padding:20px;background:#faf3e6"><section class="tn-comp-top-level"><h2 style="color:#724234">测试标题</h2><p><strong>保留加粗</strong><a href="https://example.com">保留链接</a></p></section><section class="tn-comp-top-level"><p>可编辑原文</p><img src="${src}" /></section><section class="tn-comp-top-level"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect id="trigger" width="100" height="40" fill="red"><set attributeName="visibility" to="hidden" dur="0.1s" begin="trigger.click" /></rect><foreignObject width="100" height="40"><p xmlns="http://www.w3.org/1999/xhtml">卡片文字</p></foreignObject></svg></section></section>`, "原生测试模板");
    await api.saveProject(project);
  }, `data:image/png;base64,${pixel}`);
  await ready(page); await expect(page.getByRole("document", { name: "复刻稿件编辑画布" })).toBeVisible();
}
test("imported clone opens an editable canvas, preserves style and persists text without editor export markup", async ({ page }) => {
  await setup(page);
  const field = page.getByRole("textbox", { name: "画布文字 可编辑原文", exact: true });
  await field.fill("直接编辑中文"); await field.press("End"); await field.pressSequentially("ABC");
  await saved(page); await page.reload(); await saved(page);
  await expect(field).toHaveText("直接编辑中文ABC");
  await expect(page.locator(".native-editable-article strong")).toHaveText("保留加粗");
  await expect(page.locator(".native-editable-article a")).toHaveAttribute("href", "https://example.com/");
  const html = await page.evaluate(async () => window.opTest.renderProject((await window.opTest.loadActiveProject())!));
  expect(html).toContain("直接编辑中文ABC"); expect(html).toContain("foreignObject"); expect(html).toMatch(/begin="opslion_svg_\d+_\d+\.click"/);
  expect(html).not.toMatch(/contenteditable|data-layout-slot|data-layout-module|data-op-selected|画布编辑/);
});
test("native library supports insert, move, delete, undo and isolated SVG copies", async ({ page }) => {
  await setup(page);
  await page.getByRole("textbox", { name: "画布文字 可编辑原文", exact: true }).click();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "当前模板模块" })).toBeVisible();
  await page.getByLabel("模块插入位置").selectOption("before");
  await page.getByRole("button", { name: "插入正文模块", exact: true }).click();
  const added = page.getByRole("textbox", { name: "画布文字 正文", exact: true }); await expect(added).toBeFocused(); await added.fill("新增正文");
  await page.getByRole("button", { name: "画布上移模块", exact: true }).click();
  await expect(page.locator(".native-editable-article [data-layout-module]").first()).toHaveText("新增正文");
  await page.getByRole("button", { name: "画布删除模块", exact: true }).click(); await expect(added).toHaveCount(0);
  await page.getByRole("button", { name: "撤销编辑", exact: true }).click(); await expect(added).toHaveText("新增正文");
  await page.getByRole("button", { name: "重做编辑", exact: true }).click(); await expect(added).toHaveCount(0);
  await page.getByRole("button", { name: "插入原稿模块 正文 · 卡片文字", exact: true }).click();
  await expect(page.locator(".native-editable-article svg")).toHaveCount(2);
  const targets = await page.locator(".native-editable-article svg").evaluateAll((svgs) => svgs.map((svg) => ({ id: svg.querySelector("rect")!.id, begin: svg.querySelector("set")!.getAttribute("begin") })));
  expect(targets[0].id).not.toBe(targets[1].id); expect(targets[1].begin).toBe(`${targets[1].id}.click`);
  await page.getByRole("button", { name: "收起模块边栏", exact: true }).click(); await expect(page.locator(".template-module-sidebar")).toBeHidden();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click(); await expect(page.locator(".template-module-sidebar")).toBeVisible();
});
test("native images insert and replace from the canvas, readonly mode stays clean", async ({ page }) => {
  await setup(page); await page.getByRole("textbox", { name: "画布文字 可编辑原文", exact: true }).click();
  await page.locator(".preview-toolbar").getByRole("button", { name: "模板模块", exact: true }).click();
  await page.getByRole("button", { name: "插入图片模块", exact: true }).click();
  await page.getByLabel("复刻画布插入图片文件").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await expect(page.locator(".native-editable-article img")).toHaveCount(2);
  await page.locator(".native-editable-article img").last().dblclick();
  await page.getByLabel("复刻画布插入图片文件").setInputFiles({ name: "replace.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") });
  await saved(page); await page.getByRole("group", { name: "画布模式", exact: true }).getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".preview-content [contenteditable]")).toHaveCount(0);
  await page.getByRole("button", { name: "插入标题模块", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "画布文字 标题", exact: true })).toBeFocused();
});

test("moving a native module rebases submission SVG locations for subsequent updates", async ({ page }) => {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async () => {
    const api = window.opTest; const project = api.createDefaultProject(); project.mode = "clone";
    project.cloneTemplate = api.analyzeTemplateHtml('<section><section class="tn-comp-top-level"><p>保留模块</p></section><section class="tn-comp-top-level"><p>定位模块</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><text x="0" y="20">原生说明</text></svg></section></section>', "绑定测试");
    const baseline = api.submission.captureBaseline(api.submission.emptySubmission("update"), project);
    const target = baseline.base_article!.nodes.find((node) => "content" in node && api.layoutEngine.richTextToPlain(node.content) === "原生说明")!;
    project.submission = { ...api.submission.assembleSubmission(baseline, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: project.id, changes: [{ op: "set_content", target_node_id: target.id, content: [{ text: "修改说明" }] }], image_requests: [], pending: [] }), applied: true };
    project.cloneTemplate = api.submission.applyNativeDraft(project.cloneTemplate, project.submission);
    await api.saveProject(project);
  });
  await ready(page); await page.getByRole("textbox", { name: "画布文字 定位模块", exact: true }).click();
  await page.getByRole("button", { name: "画布上移模块", exact: true }).click(); await saved(page);
  const result = await page.evaluate(async () => {
    const api = window.opTest; const project = (await api.loadActiveProject())!;
    const binding = Object.values(project.submission!.native_bindings!).find((binding) => binding.native_path)!;
    const doc = new DOMParser().parseFromString(project.cloneTemplate!.analyzedHtml, "text/html");
    const target = binding.native_path!.reduce<Element | undefined>((element, index) => element?.children[index], doc.body);
    const next = api.submission.applyNativeDraft(project.cloneTemplate!, project.submission!);
    return { target: target?.textContent, html: api.renderProject({ ...project, cloneTemplate: next }) };
  });
  expect(result.target).toBe("修改说明"); expect(result.html).toContain("保留模块"); expect(result.html).toContain("修改说明");
});

test("legacy compose switches between middle content editing and its original themed preview", async ({ page }) => {
  await mockBridge(page); await ready(page); await saved(page);
  const before = await page.evaluate(async () => { const p = (await window.opTest.loadActiveProject())!; return { theme: p.theme, density: p.density, accent: p.accentOverride }; });
  const mode = page.getByRole("group", { name: "画布模式", exact: true });
  await expect(mode.getByRole("button", { name: "预览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await mode.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("textbox", { name: "画布文章标题", exact: true }).fill("中间直接修改标题");
  await page.getByRole("textbox", { name: "画布第 1 节正文", exact: true }).fill("保留旧模板的正文\n\n第二段。");
  await mode.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".preview-content h1")).toHaveText("中间直接修改标题");
  await expect(page.locator(".preview-content")).toContainText("保留旧模板的正文");
  await expect(page.locator(".preview-content input, .preview-content textarea")).toHaveCount(0);
  await mode.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "画布第 1 节正文", exact: true })).toHaveValue("保留旧模板的正文\n\n第二段。");
  await expect(page.getByRole("dialog")).toHaveCount(0); await saved(page); await page.reload(); await saved(page);
  const after = await page.evaluate(async () => { const p = (await window.opTest.loadActiveProject())!; return { theme: p.theme, density: p.density, accent: p.accentOverride, layout: p.layout, html: window.opTest.renderProject(p) }; });
  expect(after).toMatchObject(before); expect(after.layout).toBeFalsy(); expect(after.html).toContain("中间直接修改标题"); expect(after.html).not.toContain("legacy-canvas-fields");
});
