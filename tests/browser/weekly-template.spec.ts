import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { normalizePayload } from "../../integrations/xiumi-bridge/payload.js";
import { applyBridgeInPage } from "../../integrations/xiumi-bridge/page-runtime.js";
import { installXiumiModel } from "../fixtures/xiumi-model.js";
import { mockBridge, ready } from "./helpers";

const header = "<!-- opslion:hello-week/v1 -->\n# 本期周报\n<!-- layout: inset -->\n\n";
const section = ":::section 下周及后续\n:::\n\n:::category 活动信息\n:::\n\n";
async function openWeekly(page: Page) {
  await mockBridge(page); await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
}
const importCopy = (page: Page, text: string) => page.getByLabel("导入周报文案文件").setInputFiles({ name: "本期周报.md", mimeType: "text/markdown", buffer: Buffer.from(text, "utf8") });

test("five real structural variants preserve sections, news counts, spacing and optional endings", async ({ page }) => {
  await ready(page, true);
  const cases = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekExamples.map((example) => ({ ...example, ...window.opTest.weeklyTemplate.renderHelloWeek(example.text) })));
  expect(cases.map((item) => item.newsCount)).toEqual([5, 8, 12, 7, 6]);
  expect(cases.map((item) => item.layout)).toEqual(["classic", "inset", "classic", "spaced", "inset"]);
  for (const item of cases) {
    await page.setContent(`<style>body{margin:0}article{width:390px;max-width:100%;margin:auto}</style><article>${item.html}</article>`);
    await expect(page.locator('[data-layout-module="weekly-news"]')).toHaveCount(item.newsCount);
    await expect(page.locator('[data-layout-module="weekly-news"] a')).toHaveCount(item.newsCount);
    await expect(page.locator("article > section")).toHaveCSS("font-size", "14px");
    await expect(page.locator("article > section")).toHaveCSS("line-height", "28px");
    await expect(page.locator("article > section")).toHaveCSS("padding-left", item.layout === "inset" ? "12px" : "0px");
    await expect(page.locator("article > section")).toHaveCSS("letter-spacing", item.layout === "classic" ? "normal" : "1px");
    expect(await page.locator("img").evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.locator("article").screenshot({ path: `test-results/hello-week-${item.id}.png` });
  }
  expect(cases[0].html).toContain("weekly-welcome");
  expect(cases[3].html).not.toMatch(/weekly-notice|查收重要提示|weekly-closing/);
  expect(cases[4].html).toContain("weekly-closing");
  expect(cases[4].html).toContain("EndOfSpringSemester");
  for (const scene of ["场次一的示例时间", "场次二的示例时间", "场次三的示例时间"]) expect(cases[4].html).toContain(scene);
});

test("all modules keep long copy, nested event fields, source query strings and literal HTML safely", async ({ page }) => {
  await ready(page, true);
  const long = "摘要包含完整的活动安排和限制条件。".repeat(100) + "长摘要结尾不能丢失";
  const url = "https://mp.weixin.qq.com/s?__biz=synthetic&mid=123&idx=1&sn=abc&scene=21";
  const extra = `:::news ${"很长的资讯标题".repeat(15)}\n- 毕业典礼：\n  时间：10:00\n  地点：第三会场\n- 内容：${long}\n- 详情请见：[带查询参数的原文](${url})\n- 另见：[含括号的原文](https://example.com/events/(fall)?a=1&b=2)\n- 说明：<script>window.weeklyBad=true</script> {{footer}}\n:::\n`;
  const result = await page.evaluate((copy) => window.opTest.weeklyTemplate.renderHelloWeek(copy), header + section + extra);
  await page.setContent(`<style>body{margin:0}article{width:390px;max-width:100%;margin:auto}</style><article>${result.html}</article>`);
  await expect(page.locator("article")).toContainText(long);
  await expect(page.locator("article")).toContainText("地点：第三会场");
  await expect(page.locator("article a").first()).toHaveAttribute("href", url);
  await expect(page.locator("article a").nth(1)).toHaveAttribute("href", "https://example.com/events/(fall)?a=1&b=2");
  await expect(page.locator("article")).toContainText("<script>window.weeklyBad=true</script> {{footer}}");
  await expect(page.locator("article script,[contenteditable]" )).toHaveCount(0);
  for (const width of [375, 390, 414]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('[data-layout-module="weekly-news"]').evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  }
});

test("invalid modules and unsupported content stop the whole render with useful source lines", async ({ page }) => {
  await ready(page, true);
  const failures = [
    { copy: "# 普通 Markdown", message: "首行需要" },
    { copy: header + ":::unknown\n内容\n:::", message: "未知模块" },
    { copy: header + ":::contact\n原文\n:::banner\n:::", message: "上一模块缺少" },
    { copy: header + ":::contact\n原文", message: "模块缺少结束标记" },
    { copy: header + ":::banner\n多出的正文\n:::", message: "固定模块" },
    { copy: header + ":::notice 提醒\n:::", message: "正文为空" },
    { copy: header + ":::news 条目\n- 内容\n:::", message: "分区和 category" },
    { copy: header + section + ":::news 条目\n没有来源\n:::", message: "至少一个" },
    { copy: header + section + ":::news 条目\n[危险链接](javascript:alert(1))\n:::", message: "HTTP(S)" },
    { copy: header + ":::image\n![图片](asset:unknown)\n:::", message: "未知模板素材" },
    { copy: header + ":::image\n![图片](assets/000001.png)\n:::", message: "HTTP(S) 地址" },
    { copy: header + ":::spacer 999\n:::", message: "留白高度" },
    { copy: header + "模块之外的正文", message: "模块外不能" },
    { copy: header + ":::closing\n```cpp\n未结束代码\n:::", message: "代码块缺少" },
    { copy: header + ":::callout 标题\n\n![配图](file:///C:/hidden.png)\n:::", message: "第 7 行" },
    { copy: header + ":::callout 标题\n说明\n| 姓名 | 联系方式 |\n:::", message: "不支持表格" },
    { copy: header + ":::callout 标题\n- 场次一\n    四个空格\n:::", message: "恰好使用两个空格" },
  ];
  for (const item of failures) {
    const error = await page.evaluate((text) => { try { window.opTest.weeklyTemplate.renderHelloWeek(text); return ""; } catch (error) { return (error as Error).message; } }, item.copy);
    expect(error).toContain(item.message);
    expect(error).toMatch(/^第 \d+ 行：/);
  }
});

test("import lays out read-only copy without model calls and exports bundled native modules accepted by the plugin", async ({ page }) => {
  await openWeekly(page);
  let modelCalls = 0;
  await page.route("**/local-api/agent/plan", (route) => { modelCalls++; return route.fulfill({ status: 500, json: {} }); });
  const example = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekExamples[4]);
  await importCopy(page, example.text);
  await expect(page.getByLabel("周报文案原文")).not.toBeEditable();
  await expect(page.getByRole("button", { name: /整理到周报/ })).toHaveCount(0);
  await expect(page.getByLabel("周报标题", { exact: true })).toHaveCount(0);
  await expect(page.locator(".hello-week-paper [contenteditable]" )).toHaveCount(0);
  await expect(page.locator('.hello-week-paper [data-layout-module="weekly-news"]')).toHaveCount(6);
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeEnabled();
  await expect(page.locator(".weekly-save-state")).toHaveText("已保存到本机");
  await page.reload(); await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByLabel("周报文案原文")).toHaveValue(example.text);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Bridge 包", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toContain("学期收官");
  const packet = normalizePayload(JSON.parse(await readFile(await download.path(), "utf8")));
  expect(packet.schema).toBe("xiumi-bridge/v3");
  expect(packet.assetSummary).toMatchObject({ local: 0, embedded: 6 });
  expect(packet.assets.every((asset: { src: string }) => asset.src.startsWith("data:image/"))).toBe(true);
  expect(packet.patch).toBeUndefined();
  expect(packet.native.pageFormat.styles).toMatchObject({ "padding-left": "12px", "padding-right": "12px", "font-size": "14px", "letter-spacing": "1px" });
  expect(JSON.stringify(packet)).not.toContain("/assets/hello-week/");
  expect(packet.native.modules.length).toBeGreaterThan(20);
  expect(modelCalls).toBe(0);

  await page.addInitScript(`window.bridgeRuntime = ${applyBridgeInPage.toString()};`);
  await page.route("https://xiumi.us/**", (route) => route.fulfill({ contentType: "text/html", body: '<article class="tn-page-inst" tn-comp-role="page"><section class="tn-comp-style-pin"></section></article>' }));
  await page.goto("https://xiumi.us/studio/v5#/paper/for/123/cube/0");
  await page.evaluate(installXiumiModel, {});
  const result = await page.evaluate((data) => window.bridgeRuntime(data, "insert"), packet);
  expect(result.ok, result.message).toBe(true);
  expect(result.receipt?.modules).toBe(packet.native.modules.length);
  const snapshot = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { xiumiModel: unknown }).xiumiModel)));
  expect(JSON.stringify(snapshot.model)).not.toMatch(/data:image|opslion-asset:|\/assets\/hello-week\//);
  expect(snapshot.calls.filter((value: string) => value.startsWith("upload:"))).toHaveLength(1);
  expect(snapshot.page.comp._comp.style.paddingLeft).toBe("12px");
  await page.reload();
  await page.evaluate(installXiumiModel, { html: snapshot.model.map((comp: { txt1: { text: string } }) => comp.txt1.text), pageStyle: snapshot.page.comp._comp.style });
  const verification = await page.evaluate(({ packet, receipt }) => window.bridgeRuntime(packet, "verify", receipt), { packet, receipt: result.receipt });
  expect(verification.ok, verification.message).toBe(true);
});

test("sample browsing never overwrites an imported report, and mobile preview remains usable", async ({ page }) => {
  await openWeekly(page);
  const copy = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekStarter);
  await importCopy(page, copy);
  await page.getByRole("button", { name: "查看五种模板示例" }).click();
  await page.getByLabel("周报示例", { exact: true }).selectOption("brief");
  await expect(page.locator('[data-layout-module="weekly-notice"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "返回本期周报" }).click();
  await expect(page.getByLabel("周报文案原文")).toHaveValue(copy);
  await expect(page.getByRole("button", { name: "下载 Bridge 包", exact: true })).toBeEnabled();
  await page.locator(".hello-week-preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/hello-week-workspace-desktop.png" });
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByLabel("周报预览宽度", { exact: true }).selectOption(String(width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".hello-week-preview-toolbar").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/hello-week-workspace-${width}.png` });
  }
});

test("standalone HTML embeds artwork and asset read failures cannot download a broken report", async ({ page }) => {
  await openWeekly(page);
  const copy = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekStarter);
  await importCopy(page, copy);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "HTML", exact: true }).click();
  const html = await readFile(await (await downloading).path(), "utf8");
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("data:image/png;base64,");
  expect(html).not.toContain("/assets/hello-week/");
  let downloads = 0; page.on("download", () => downloads++);
  const bannerPath = await page.evaluate(() => window.opTest.weeklyTemplate.definition.assets.banner.src);
  await page.route(`**${bannerPath}`, (route) => route.fulfill({ status: 500, body: "unavailable" }));
  await page.getByRole("button", { name: "下载 Bridge 包", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("本地素材读取失败");
  expect(downloads).toBe(0);
  const oversize = await page.evaluate(async () => {
    try { await window.opTest.weeklyTemplate.createWeeklyBridgePackage(`<p>${"文".repeat(1_400_001)}</p>`, "过长示例"); return ""; }
    catch (error) { return (error as Error).message; }
  });
  expect(oversize).toContain("超过插件可接收");
});

test("shipped template archive matches the compiler, all examples render and all module types appear", async ({ page }) => {
  await ready(page, true);
  const zip = await JSZip.loadAsync(await readFile("public/weekly/hello-week-template-v1.zip"));
  const definitionText = await zip.file("hello-week.template.json")!.async("string");
  const definition = JSON.parse(definitionText);
  expect(definition).toEqual(await page.evaluate(() => window.opTest.weeklyTemplate.definition));
  expect(await readFile("public/weekly/hello-week.template.json", "utf8")).toBe(definitionText);
  const starter = await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekStarter);
  expect(await zip.file("starter.md")!.async("string")).toBe(starter);
  expect(await readFile("public/weekly/starter.md", "utf8")).toBe(starter);
  expect(zip.file("README.md")).toBeNull();
  expect(zip.file("reference-analysis.md")).toBeNull();
  const catalog = await zip.file("all-modules.md")!.async("string");
  const rendered = await page.evaluate((copy) => {
    const result = window.opTest.weeklyTemplate.renderHelloWeek(copy);
    const root = document.createElement("div"); root.innerHTML = result.html;
    return [...root.querySelectorAll(".tn-comp-top-level")].map((node) => node.getAttribute("data-layout-module")!.slice(7));
  }, catalog);
  expect(new Set(rendered)).toEqual(new Set(Object.keys(definition.modules)));
  for (const item of await page.evaluate(() => window.opTest.weeklyTemplate.helloWeekExamples)) {
    expect(await zip.file(`examples/${item.filename}`)!.async("string")).toBe(item.text);
    const preview = await zip.file(`preview/${item.id}.html`)!.async("string");
    expect(preview).toContain(definition.assets.banner.src.replace("/assets/hello-week/", "../assets/"));
    expect(preview).not.toContain("/assets/hello-week/");
  }
  const expectedAssets: string[] = [];
  const assetPaths: string[] = [];
  for (const asset of Object.values(definition.assets) as { src: string }[]) {
    const basename = asset.src.split("/").pop();
    const original = await readFile(`public${asset.src}`);
    expect(await zip.file(`assets/${basename}`)!.async("nodebuffer")).toEqual(original);
    expectedAssets.push(original.toString("base64"));
    assetPaths.push(`assets/${basename}`);
  }
  expect(Object.keys(zip.files).filter((name) => name.startsWith("assets/") && !zip.files[name].dir).sort()).toEqual(assetPaths.sort());
  const packet = normalizePayload(JSON.parse(await zip.file("Hello-Week-example.xiumi.json")!.async("string")));
  expect(packet.assetSummary).toMatchObject({ embedded: 7, local: 0 });
  expect(new Set(packet.assets.map((asset: { src: string }) => asset.src.split(",", 2)[1]))).toEqual(new Set(expectedAssets));
});


test("the published copy Skill uses the same template contract and omits template-owned blocks", async ({ page }) => {
  await ready(page, true);
  const zip = await JSZip.loadAsync(await readFile("skills/Hello_Week_Skill.zip"));
  const prefix = "hello-week-copy/references/template/";
  const definition = JSON.parse(await zip.file(prefix + "hello-week.template.json")!.async("string"));
  expect(definition).toEqual(await page.evaluate(() => window.opTest.weeklyTemplate.definition));
  const examples = Object.keys(zip.files).filter((name) => name.startsWith(prefix) && name.endsWith(".md") && !name.endsWith("README.md"));
  for (const name of examples) {
    const copy = await zip.file(name)!.async("string");
    expect(copy).not.toMatch(/^:::(?:contact|credits)\b/m);
    const rendered = await page.evaluate((copy) => window.opTest.weeklyTemplate.renderHelloWeek(copy), copy);
    expect(rendered.html).toContain('data-layout-module="weekly-contact"');
    expect(rendered.html).toContain('data-layout-module="weekly-credits"');
  }
});
