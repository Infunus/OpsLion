import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

test.beforeEach(async ({ page }) => ready(page, true));

test("master inline shells, full page format, background assets and SVG survive long content and package round trips", async ({ page }, testInfo) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine;
    const template = structuredClone(e.testTemplates[0]); template.id = "fidelity-fixture";
    template.pageFormat = { styles: { "font-size": "14px", "line-height": "28px", "letter-spacing": "1px", "color": "#fff6df", "padding-top": "12px", "padding-right": "12px", "padding-bottom": "12px", "padding-left": "12px", "background-color": "#213e71" }, source: { selector: ".tn-page-inst > .tn-comp-style-pin" } };
    template.mapping.heading1 = { component: "heading1", fields: { body: { from: "content" } }, regions: {} };
    template.assets.paperTexture = "https://statics.xiumi.us/test/paper.gif";
    template.components.heading1 = e.componentSchema.parse({ role: "heading1", layoutPart: "root", source: { kind: "markup", html: '<section data-layout-part="root" data-layout-background="paperTexture" style="margin:0;border:2px solid #d1aa56;background-size:22.242% auto;background-repeat:repeat-y"><svg viewBox="0 0 80 8" width="100%" height="8"><defs><path id="line" d="M0 4H80"/></defs><use href="#line" stroke="#d1aa56"/></svg><h2 data-layout-part="body" style="margin:0"><span style="font-size:24px;color:#ecd689;letter-spacing:3px"><strong>示例文字</strong></span></h2></section>' }, fields: { body: { kind: "richtext", bindings: [{ type: "richtext", part: "body" }] } } });
    const article = structuredClone(e.testArticle); article.nodes = [{ id: "t", type: "article_title", content: [{ text: "母版保真检查" }] }, { id: "h1", type: "heading1", content: [{ text: "金色标题" }] }, { id: "p1", type: "paragraph", content: [{ text: "正文自然延展。".repeat(20) }] }, { id: "h2", type: "heading1", content: [{ text: "第二个标题" }] }, { id: "p2", type: "paragraph", content: [{ text: "另一段内容。" }] }];
    const published = e.publishTemplate(template); const output = e.compileArticle(article, published, null, {}, { native: true });
    const nativeDoc = new DOMParser().parseFromString(output.native!.modules.map((module) => module.html).join(""), "text/html");
    const nativeIds = [...nativeDoc.querySelectorAll("defs path")].map((path) => path.id);
    const holder = document.createElement("div"); holder.innerHTML = output.html; holder.style.width = "390px"; document.body.append(holder);
    const before = holder.clientHeight;
    article.nodes.push({ id: "long", type: "paragraph", content: [{ text: "更长的正文，保留自然换行。".repeat(150) }] });
    const longer = e.compileArticle(article, JSON.parse(JSON.stringify(published))); holder.innerHTML = longer.html;
    const grows = holder.clientHeight > before + 400;
    const heading = holder.querySelector("h2 span") as HTMLElement;
    const firstBody = holder.querySelector("p") as HTMLElement;
    const root = holder.firstElementChild as HTMLElement;
    const refs = [...holder.querySelectorAll("use")].map((use) => use.getAttribute("href"));
    const ids = [...holder.querySelectorAll("defs path")].map((path) => `#${path.id}`);
    return { html: longer.html, grows, nested: holder.querySelector("h2 span strong")?.textContent, heading: { size: getComputedStyle(heading).fontSize, color: getComputedStyle(heading).color, tracking: getComputedStyle(heading).letterSpacing }, body: getComputedStyle(firstBody).fontSize, paper: { background: root.style.backgroundColor, left: root.style.paddingLeft, line: root.style.lineHeight }, backgrounds: [...holder.querySelectorAll('section[style*="paper.gif"]')].map((element) => (element as HTMLElement).style.backgroundSize), refs, ids, nativeIds, nativeCount: output.native?.modules.length, nativePaper: output.native?.pageFormat.styles, hasMarkers: /data-layout-(?:part|slot|module|origin)/.test(longer.html) };
  });
  expect(result.grows).toBe(true);
  expect(result.nested).toBe("金色标题");
  expect(result.heading).toEqual({ size: "24px", color: "rgb(236, 214, 137)", tracking: "3px" });
  expect(result.body).toBe("14px");
  expect(result.paper).toEqual({ background: "rgb(33, 62, 113)", left: "12px", line: "28px" });
  expect(result.backgrounds).toEqual(["22.242% auto", "22.242% auto"]);
  expect(result.refs).toEqual(result.ids); expect(new Set(result.ids).size).toBe(2);
  expect(result.nativeCount).toBe(5); expect(result.hasMarkers).toBe(false);
  expect(new Set(result.nativeIds).size).toBe(2);
  await testInfo.attach("fidelity.html", { body: result.html, contentType: "text/html" });
  await page.screenshot({ path: testInfo.outputPath("fidelity.png"), fullPage: true });
});

test("mixed text and decoration cannot be destroyed through an ambiguous parent binding", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine;
    const template = e.publishTemplate(e.testTemplates[0]);
    template.components.body.source.html = '<section data-layout-part="root" style="margin:0"><p data-layout-part="body"><span style="color:red">第一样式</span><span style="color:blue">第二样式</span></p></section>';
    let message = ""; try { e.compileArticle(e.testArticle, template); } catch (error) { message = e.explainLayoutError(error); }
    template.components.body.fields.body.bindings = [{ type: "richtext", part: "body", mode: "replace" }];
    const explicit = e.compileArticle(e.testArticle, template).html;
    return { message, explicit: explicit.includes("第一样式"), containsArticle: explicit.includes("每种内容都有自己的位置") };
  });
  expect(result.message).toContain("叶节点"); expect(result.explicit).toBe(false);
});

test("image and structural changes disable text-only patches; copied Base64 requires the asset import path", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.opTest; const state = api.analyzeTemplateHtml('<section><p>示例</p><img src="https://statics.xiumi.us/a.png"></section>', "示例");
    state.slots.find((slot) => slot.kind === "image")!.value = "https://statics.xiumi.us/b.png";
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: state };
    const packet = api.bridge.createProjectBridgePackage(project, api.renderProject(project), "示例");
    const notices: string[] = [];
    const html = '<section style="background-image:url(data:image/png;base64,AAAA)"><p>背景图</p></section>';
    const projectForExport = api.createDefaultProject();
    await api.createExportActions(projectForExport, html, [], (message) => notices.push(message), () => {}).copyRichText();
    return { patch: packet.patch, notices };
  });
  expect(result.patch.available).toBe(false); expect(result.patch.reasons.join(" ")).toContain("图片已改变");
  expect(result.notices[0]).toContain("Bridge");
});

test("a standalone SVG remains one complete native module with its authored font scale", async ({ page }) => {
  const result = await page.evaluate(() => {
    const packet = window.opTest.bridge.createHtmlBridgePackage('<svg viewBox="0 0 320 120" width="100%" style="font-size:220%"><defs><path id="rule" d="M0 4H320"/></defs><use href="#rule"/><foreignObject width="320" height="120"><p>完整 SVG</p></foreignObject><animate attributeName="opacity" from="1" to="0" begin="click" dur="1s"/></svg>', "SVG 模块");
    const doc = new DOMParser().parseFromString(packet.native.modules[0].html, "text/html");
    return { count: packet.native.modules.length, svg: doc.querySelectorAll("svg").length, animation: doc.querySelectorAll("animate").length, size: doc.querySelector("svg")?.style.fontSize, text: doc.querySelector("foreignObject")?.textContent };
  });
  expect(result).toEqual({ count: 1, svg: 1, animation: 1, size: "220%", text: "完整 SVG" });
});
