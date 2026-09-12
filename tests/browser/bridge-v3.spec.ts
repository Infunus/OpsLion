import { test, expect, type Page } from "@playwright/test";
import { capturePage } from "../../integrations/xiumi-bridge/capture-page.js";
import { applyBridgeInPage } from "../../integrations/xiumi-bridge/page-runtime.js";
import { installXiumiModel } from "../fixtures/xiumi-model.js";
import { ready } from "./helpers";

declare global { interface Window { bridgeRuntime: typeof applyBridgeInPage } }

const fixture = '<html><body><article class="tn-page-inst" tn-comp-role="page" style="font-size:16px"><section class="tn-comp-style-pin" style="font-size:87.5%;line-height:2;letter-spacing:1px;padding:12px;background:#213E71"></section></article></body></html>';
async function editor(page: Page, options: Parameters<typeof installXiumiModel>[0] = {}) {
  await page.addInitScript(`window.bridgeRuntime = ${applyBridgeInPage.toString()};`);
  await page.route("https://xiumi.us/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.goto("https://xiumi.us/studio/v5#/paper/for/123/cube/0");
  await page.evaluate(installXiumiModel, options);
}
const bitmap = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=";

test("captured page format and exact duplicate-text positions survive project and template round trips", async ({ page }) => {
  await editor(page, { html: ['<p><span style="color:gold">重复标题</span></p>', '<p><span style="color:gold">重复标题</span></p>'] });
  const capture = await page.evaluate(capturePage);
  if (!capture?.source || !capture.html) throw new Error("capture missing");
  const nativeSource = await page.evaluate(() => window.bridgeRuntime({}, "capture-source"));
  expect(capture.source.pageFormat.styles).toMatchObject({ "font-size": "14px", "line-height": "28px", "letter-spacing": "1px", "background-color": "rgb(33, 62, 113)", "padding-left": "12px" });
  await ready(page, true);
  const packet = await page.evaluate((capture) => {
    const api = window.opTest;
    const state = api.analyzeTemplateHtml(capture.html, "双标题母版", capture.source);
    state.slots[1].value = "第二个标题已修改";
    const project = api.parseProjectFile(JSON.parse(JSON.stringify({ ...api.createDefaultProject(), mode: "clone", cloneTemplate: state })));
    return api.bridge.createProjectBridgePackage(project, api.renderProject(project), "验证");
  }, { ...capture, source: { ...capture.source, nativeModuleHashes: nativeSource.nativeModuleHashes } });
  expect(packet.patch.available, packet.patch.reasons.join("；")).toBe(true);
  expect(packet.patch.operations).toEqual([{ module: 1, cell: 0, start: 0, end: 4, search: "重复标题", text: "第二个标题已修改", expectedHref: "", href: "" }]);
  expect(packet.native.modules).toHaveLength(2);
  await editor(page, { html: ['<p><span style="color:gold">重复标题</span></p>', '<p><span style="color:gold">重复标题</span></p>'] });
  const result = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(result.ok, result.message).toBe(true);
  await expect(page.locator('[contenteditable="true"]').nth(0)).toHaveText("重复标题");
  await expect(page.locator('[contenteditable="true"]').nth(1)).toHaveText("第二个标题已修改");
  await expect(page.locator('[contenteditable="true"]').nth(1).locator("span")).toHaveCSS("color", "rgb(255, 215, 0)");
  const repeat = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(repeat.ok).toBe(false);
});

test("all replacements are checked before any write; wrong draft, stale text and overlapping ranges fail", async ({ page }) => {
  await editor(page, { html: ["<p>甲标题</p>", "<p>乙标题</p>"] });
  const baseline = await page.evaluate(() => window.bridgeRuntime({}, "capture-source"));
  const packet = { schema: "xiumi-bridge/v3", html: "<p>新标题</p>", patch: { available: true, source: { paperId: "123", nativeModuleHashes: baseline.nativeModuleHashes, modules: [{ index: 0, cells: ["甲标题"] }, { index: 1, cells: ["乙标题"] }] }, operations: [{ module: 0, cell: 0, start: 0, end: 3, search: "甲标题", text: "更改", href: "", expectedHref: "" }, { module: 1, cell: 0, start: 0, end: 3, search: "过期值", text: "错误", href: "", expectedHref: "" }] } };
  const stale = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(stale.ok).toBe(false);
  await expect(page.locator('[contenteditable="true"]').nth(0)).toHaveText("甲标题");
  packet.patch.source.paperId = "999";
  const wrong = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(wrong.message).toContain("不是抓取时的原稿");
  packet.patch.source.paperId = "123"; packet.patch.operations[1] = { ...packet.patch.operations[0] };
  const duplicate = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(duplicate.message).toContain("重叠");
});

test("native import binds duplicate bitmap and background once, creates separate models and verifies serialized reopening", async ({ page }) => {
  await ready(page, true);
  const packet = await page.evaluate((bitmap) => window.opTest.bridge.createHtmlBridgePackage(`<section style="font-size:14px;line-height:2;background-image:url('${bitmap}');background-size:22.242% auto;background-repeat:repeat-y"><section><p>第一模块</p><img src="${bitmap}"></section><section><p>第二模块</p><img src="${bitmap}"></section></section>`, "原生模块验收"), bitmap);
  expect(JSON.stringify(packet).split(bitmap).length - 1).toBe(1);
  expect(packet.native.modules).toHaveLength(2);
  await editor(page);
  await page.evaluate(() => localStorage.setItem("ngStorage-localShowData", "preserve synthetic cache"));
  const result = await page.evaluate((packet) => window.bridgeRuntime(packet, "insert"), packet);
  expect(result.ok, result.message).toBe(true);
  expect(result.receipt?.modules).toBe(2);
  await expect(page.locator(".tn-comp-top-level")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("ngStorage-localShowData"))).toBe("preserve synthetic cache");
  const snapshot = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { xiumiModel: { model: unknown; page: unknown; calls: string[] } }).xiumiModel)));
  expect(snapshot.calls.filter((value: string) => value.startsWith("upload:"))).toEqual(["upload:1"]);
  expect(JSON.stringify(snapshot.model)).not.toContain("data:image");
  expect(snapshot.page.comp._comp.style.backgroundSize).toBe("22.242% auto");
  await page.reload();
  await page.evaluate(installXiumiModel, { html: snapshot.model.map((comp: { txt1: { text: string } }) => comp.txt1.text), pageStyle: snapshot.page.comp._comp.style });
  const verification = await page.evaluate(({ packet, receipt }) => window.bridgeRuntime(packet, "verify", receipt), { packet, receipt: result.receipt });
  expect(verification.ok, verification.message).toBe(true);
  expect(verification.message).toContain("重新加载");
});

test("upload failure, unsafe input and failed model insertion leave the draft untouched", async ({ page }) => {
  const packet = { schema: "xiumi-bridge/v3", html: "<p>测试</p>", native: { modules: [{ id: "one", html: `<p>测试</p><img src="${bitmap}">` }], pageFormat: { styles: { "background-color": "#213E71" } } }, assets: [] };
  await editor(page, { failUpload: true });
  const upload = await page.evaluate((packet) => window.bridgeRuntime(packet, "insert"), packet);
  expect(upload.message).toContain("上传失败");
  await expect(page.locator(".tn-comp-top-level")).toHaveCount(0);
  await editor(page, { failInsert: true });
  const insert = await page.evaluate((packet) => window.bridgeRuntime(packet, "insert"), packet);
  expect(insert.ok).toBe(false);
  await expect(page.locator(".tn-comp-top-level")).toHaveCount(0);
  packet.native.modules[0].html = '<svg><foreignObject><div onclick="bad()">危险</div></foreignObject></svg>';
  const unsafe = await page.evaluate((packet) => window.bridgeRuntime(packet, "insert"), packet);
  expect(unsafe.message).toContain("脚本事件");
});

test("module fingerprints catch reordered decorations even when every text cell is identical", async ({ page }) => {
  await editor(page, { html: ['<p style="color:red">相同正文</p>', '<p style="color:blue">相同正文</p>'] });
  const baseline = await page.evaluate(() => window.bridgeRuntime({}, "capture-source"));
  await editor(page, { html: ['<p style="color:blue">相同正文</p>', '<p style="color:red">相同正文</p>'] });
  const packet = { schema: "xiumi-bridge/v3", html: "<p>新正文</p>", patch: { available: true, source: { paperId: "123", nativeModuleHashes: baseline.nativeModuleHashes, modules: [{ index: 0, cells: ["相同正文"] }, { index: 1, cells: ["相同正文"] }] }, operations: [{ module: 0, cell: 0, start: 0, end: 4, search: "相同正文", text: "新正文", href: "", expectedHref: "" }] } };
  const result = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(result.ok).toBe(false); expect(result.message).toContain("顺序与抓取时不同");
  await expect(page.locator('[contenteditable="true"]').nth(0)).toHaveText("相同正文");
});

test("native text patches preserve line breaks and styles when adding or removing a link", async ({ page }) => {
  await editor(page, { html: ['<p><span style="color:gold">原文</span></p>', '<p><a href="https://example.com/old"><strong>旧链接</strong></a></p>'] });
  const baseline = await page.evaluate(() => window.bridgeRuntime({}, "capture-source"));
  const packet = { schema: "xiumi-bridge/v3", html: "<p>修改</p>", patch: { available: true, source: { paperId: "123", nativeModuleHashes: baseline.nativeModuleHashes, modules: [{ index: 0, cells: ["原文"] }, { index: 1, cells: ["旧链接"] }] }, operations: [{ module: 0, cell: 0, start: 0, end: 2, search: "原文", text: "第一行\n第二行", href: "https://example.com/new", expectedHref: "" }, { module: 1, cell: 0, start: 0, end: 3, search: "旧链接", text: "普通文字", href: "", expectedHref: "https://example.com/old" }] } };
  const result = await page.evaluate((packet) => window.bridgeRuntime(packet, "patch"), packet);
  expect(result.ok, result.message).toBe(true);
  await expect(page.locator('[contenteditable="true"]').nth(0).locator("a br")).toHaveCount(1);
  await expect(page.locator('[contenteditable="true"]').nth(0).locator("a")).toHaveCSS("color", "rgb(255, 215, 0)");
  await expect(page.locator('[contenteditable="true"]').nth(1).locator("a")).toHaveCount(0);
  await expect(page.locator('[contenteditable="true"]').nth(1).locator("strong")).toHaveText("普通文字");
});
