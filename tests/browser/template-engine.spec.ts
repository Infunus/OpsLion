import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

test.beforeEach(async ({ page }) => { await ready(page, true); });

test("repeated content, chapter growth and template switching preserve every semantic node", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine; const article = structuredClone(e.testArticle);
    article.nodes = [{ id: "title", type: "article_title", content: [{ text: "长文验证" }] }];
    for (let chapter = 1; chapter <= 3; chapter++) {
      article.nodes.push({ id: `h${chapter}`, type: "heading1", content: [{ text: `章节 ${chapter}` }] });
      for (let index = 1; index <= chapter * 10; index++) article.nodes.push({ id: `p${chapter}-${index}`, type: "paragraph", content: [{ text: `内容 ${chapter}/${index}。${"自然延展。".repeat(20)}` }] });
    }
    return e.testTemplates.map((template) => {
      const output = e.compileArticle(article, template); const again = e.compileArticle(JSON.parse(JSON.stringify(article)), JSON.parse(JSON.stringify(template)));
      const holder = document.createElement("div"); holder.innerHTML = output.html; document.body.append(holder); holder.style.width = "390px";
      const before = holder.clientHeight;
      article.nodes.push({ id: `extra-${template.id}`, type: "paragraph", content: [{ text: "新增段落。".repeat(500) }] });
      const longer = e.compileArticle(article, template); holder.innerHTML = longer.html; const after = holder.clientHeight; article.nodes.pop(); holder.remove();
      const all: { component: string; id: string; gap: number }[] = []; const visit = (item: typeof output.plan.page) => { all.push(item); Object.values(item.regions).forEach((children) => children.forEach(visit)); }; visit(output.plan.page);
      return { identical: output.html === again.html, sourceCount: output.plan.sourceOrder.length, paragraphs: all.filter((item) => item.component === "body").length, cards: all.filter((item) => item.component === "section-card").length, grows: after > before + 200, leakedMarkers: /data-layout-(?:part|slot|module)/.test(output.html), lastParagraph: output.html.includes("内容 3/30") };
    });
  });
  expect(result).toEqual([
    { identical: true, sourceCount: 64, paragraphs: 60, cards: 0, grows: true, leakedMarkers: false, lastParagraph: true },
    { identical: true, sourceCount: 64, paragraphs: 60, cards: 3, grows: true, leakedMarkers: false, lastParagraph: true },
  ]);
});

test("rich text, list starts, captions and image runs survive final sanitization", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine; const article = structuredClone(e.testArticle);
    article.nodes = [{ id: "title", type: "article_title", content: [{ text: "结构与富文本" }] }, { id: "h3", type: "heading3", content: [{ text: "直接从三级标题开始" }] }, { id: "p", type: "paragraph", content: [{ text: "保留加粗", marks: ["bold"] }, { break: true }, { href: "https://example.com/guide", content: [{ text: "保留链接", marks: ["italic"] }] }] }, { id: "list", type: "ol", start: 7, items: [{ id: "i1", content: [{ text: "第七项" }] }, { id: "i2", content: [{ text: "第八项" }] }] }];
    for (let i = 0; i < 4; i++) article.nodes.push({ id: `photo${i}`, type: "image", src: `https://example.com/photo${i}.png`, alt: `图片 ${i}`, caption: [{ text: `图注 ${i}` }] });
    article.nodes.push({ id: "break", type: "paragraph", content: [{ text: "图片组在这里断开" }] }, { id: "photo-last", type: "image", src: "https://example.com/last.png", alt: "末图" });
    const output = e.compileArticle(article, e.testTemplates[1]); const doc = new DOMParser().parseFromString(output.html, "text/html");
    const all: typeof output.plan.page[] = []; const visit = (item: typeof output.plan.page) => { all.push(item); Object.values(item.regions).forEach((children) => children.forEach(visit)); }; visit(output.plan.page);
    return { listStart: doc.querySelector("ol")?.getAttribute("start"), listChildren: [...doc.querySelector("ol")!.children].map((item) => item.tagName), bold: doc.querySelector("strong")?.textContent, link: doc.querySelector("a")?.href, italic: doc.querySelector("a em")?.textContent, captions: [...doc.querySelectorAll("figcaption")].map((item) => item.textContent), images: doc.querySelectorAll("img").length, pairCount: all.filter((item) => item.component === "image-pair").length, triples: all.filter((item) => item.component === "image-triple").length, heading1: doc.querySelectorAll("h2").length, heading3: doc.querySelectorAll("h4").length };
  });
  expect(result).toEqual({ listStart: "7", listChildren: ["LI", "LI"], bold: "保留加粗", link: "https://example.com/guide", italic: "保留链接", captions: ["图注 0", "图注 1", "图注 2", "图注 3"], images: 5, pairCount: 2, triples: 0, heading1: 0, heading3: 1 });
});

test("numbering and variants use semantic context before decorations", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine; const template = e.publishTemplate(e.testTemplates[1]);
    template.components["first-body"] = structuredClone(template.components.body);
    template.components["first-body"].source.html = template.components.body.source.html.replace("<p ", '<p title="首段" ');
    template.mapping.paragraph!.selection = { kind: "first-match", variants: [{ when: { typeIndexInSection: 1 }, component: "first-body" }] };
    template.rules.decorations = [{ position: "between-sections", level: "heading1", component: "divider", fields: {} }];
    const output = e.compileArticle(e.testArticle, template); const all: typeof output.plan.page[] = []; const visit = (item: typeof output.plan.page) => { all.push(item); Object.values(item.regions).forEach((children) => children.forEach(visit)); }; visit(output.plan.page);
    return { numbers: all.filter((item) => item.component === "heading-numbered").map((item) => item.fields.number), featured: all.filter((item) => item.component === "first-body").flatMap((item) => item.primarySources), decorationSources: all.filter((item) => item.id.includes("decoration/")).flatMap((item) => item.primarySources), sourceCount: output.plan.sourceOrder.length };
  });
  expect(result.numbers).toEqual(["01", "02"]);
  expect(result.featured).toEqual(["intro", "body-one", "ending"]);
  expect(result.decorationSources).toEqual([]);
  expect(result.sourceCount).toBe(15);
});

test("invalid parts, destructive mappings, unsafe content and unsupported nodes fail explicitly", async ({ page }) => {
  const messages = await page.evaluate(() => {
    const e = window.opTest.layoutEngine; const messages: string[] = [];
    const attempt = (run: () => void) => { try { run(); messages.push("unexpected success"); } catch (error) { messages.push(e.explainLayoutError(error)); } };
    const missing = e.publishTemplate(e.testTemplates[0]); missing.components.body.fields.body.bindings[0].part = "absent"; attempt(() => e.compileArticle(e.testArticle, missing));
    const overwrite = e.publishTemplate(e.testTemplates[0]); overwrite.mapping.paragraph!.fields.body = { literal: "旧稿文字" }; attempt(() => e.compileArticle(e.testArticle, overwrite));
    const unsafe = e.publishTemplate(e.testTemplates[0]); unsafe.components.body.source.html += '<script>window.bad = true</script>'; attempt(() => e.compileArticle(e.testArticle, unsafe));
    const article = JSON.parse(JSON.stringify(e.testArticle)); article.nodes.push({ id: "bad", type: "table", rows: [] }); attempt(() => e.compileArticle(article, e.testTemplates[0]));
    const link = JSON.parse(JSON.stringify(e.testArticle)); link.nodes[0].content = [{ href: "javascript:alert(1)", content: [{ text: "链接" }] }]; attempt(() => e.compileArticle(link, e.testTemplates[0]));
    return messages;
  });
  expect(messages.every((message) => message !== "unexpected success")).toBe(true);
  expect(messages[0]).toContain("absent"); expect(messages[1]).toContain("原始富文本");
});

test("template releases are self contained and immutable in the local library", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const e = window.opTest.layoutEngine; const template = structuredClone(e.testTemplates[1]); template.id = "saved-chapters";
    const saved = await e.saveLayoutTemplate(template); const before = e.compileArticle(e.testArticle, saved).html;
    const loaded = (await e.loadLayoutTemplates()).find((item) => item.id === template.id)!;
    let conflict = ""; try { await e.saveLayoutTemplate({ ...saved, name: "覆盖原版" }); } catch (error) { conflict = e.explainLayoutError(error); }
    await e.saveLayoutTemplate({ ...saved, version: "1.0.1", name: "更新版本" });
    return { selfContained: loaded.base === null && Boolean(loaded.components["bullet-item"]), equal: before === e.compileArticle(e.testArticle, loaded).html, conflict, releases: (await e.loadLayoutTemplates()).length };
  });
  expect(result.selfContained).toBe(true); expect(result.equal).toBe(true); expect(result.conflict).toContain("增加版本号"); expect(result.releases).toBe(2);
});

test("image grouping handles one to eight images, and cycles and counters reset in their declared scope", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine;
    const groups = Array.from({ length: 8 }, (_, index) => {
      const article = structuredClone(e.testArticle); article.nodes = [{ id: "title", type: "article_title", content: [{ text: "图片组" }] }, ...Array.from({ length: index + 1 }, (_, i) => ({ id: `photo${i}`, type: "image" as const, src: `https://example.com/${i}.png`, alt: "", caption: [{ text: `第 ${i + 1} 张` }] }))];
      const result = e.compileArticle(article, e.testTemplates[1]);
      return result.plan.page.regions.main.slice(1).map((item) => item.regions.items?.length ?? 1);
    });
    const template = e.publishTemplate(e.testTemplates[1]);
    template.components["heading2-a"] = structuredClone(template.components["heading-numbered"]); template.components["heading2-a"].role = "heading2";
    template.components["heading2-b"] = structuredClone(template.components["heading2-a"]);
    template.rules.counters.h2 = { type: "heading2", scope: "heading1", start: 1, pad: 1 };
    template.mapping.heading2 = { component: "heading2-a", fields: { title: { from: "content" }, number: { counter: "h2" } }, regions: {}, selection: { kind: "cycle", scope: "section", components: ["heading2-a", "heading2-b"] } };
    const article = structuredClone(e.testArticle); article.nodes = [{ id: "title", type: "article_title", content: [{ text: "计数范围" }] }, ...(["heading2", "heading1", "heading2", "heading2", "heading1", "heading2"] as const).map((type, index) => ({ id: `node${index}`, type, content: [{ text: `标题 ${index}` }] }))];
    article.id = "node1"; // Document IDs and heading IDs belong to different scopes.
    const output = e.compileArticle(article, template); const headings: { component: string; number: unknown }[] = [];
    const visit = (item: typeof output.plan.page) => { if (item.role === "heading2") headings.push({ component: item.component, number: item.fields.number }); Object.values(item.regions).forEach((children) => children.forEach(visit)); }; visit(output.plan.page);
    return { groups, headings };
  });
  expect(result.groups).toEqual([[1], [2], [3], [2, 2], [3, 2], [3, 3], [3, 2, 2], [3, 3, 2]]);
  expect(result.headings).toEqual([{ component: "heading2-a", number: "1" }, { component: "heading2-a", number: "1" }, { component: "heading2-b", number: "2" }, { component: "heading2-a", number: "1" }]);
});

test("valid technical prose is exportable, while list substitutions and clipped content are rejected", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const e = window.opTest.layoutEngine; const article = structuredClone(e.testArticle);
    article.nodes.push({ id: "technical", type: "paragraph", content: [{ text: '说明 onclick="example" 和 <script> 的用法。' }, { href: "https://example.com/?sessionid=ok", content: [{ text: "文档链接" }] }] });
    const output = e.compileArticle(article, e.testTemplates[0]); const errors = window.opTest.verifyHtml(output.html).filter((issue) => issue.level === "error");
    const substitutions = e.publishTemplate(e.testTemplates[0]); const items = substitutions.components["bullet-list"].regions.items; if (items.kind === "repeat") items.fields.body = { literal: "错误的替代内容" };
    let substituted = false; try { e.compileArticle(article, substitutions); } catch { substituted = true; }
    const clipped = e.publishTemplate(e.testTemplates[0]); clipped.components.body.source.html = clipped.components.body.source.html.replace('style="', 'style="height:10px;');
    let clippedRejected = false; try { e.compileArticle(article, clipped); } catch { clippedRejected = true; }
    const release = structuredClone(e.testTemplates[0]); release.id = "backup-example"; await e.saveLayoutTemplate(release);
    const backup = await window.opTest.recoveryBackup();
    return { errors, substituted, clippedRejected, backup: Array.isArray(backup.layoutLibrary) && backup.layoutLibrary.length === 1 };
  });
  expect(result).toEqual({ errors: [], substituted: true, clippedRejected: true, backup: true });
});

test("Windows line endings and inline newlines retain visible breaks through import and export", async ({ page }) => {
  const result = await page.evaluate(() => {
    const e = window.opTest.layoutEngine; const article = structuredClone(e.testArticle);
    article.nodes = [{ id: "title", type: "article_title", content: [{ text: "换行示例" }] }, { id: "p", type: "paragraph", content: [{ text: "第一行\r\n第二行\n第三行", marks: ["bold"] }] }];
    const output = e.compileArticle(article, e.testTemplates[0]); const doc = new DOMParser().parseFromString(output.html, "text/html");
    return { breaks: doc.querySelectorAll("p br").length, text: doc.querySelector("p")?.textContent, bold: doc.querySelector("strong")?.textContent };
  });
  expect(result).toEqual({ breaks: 2, text: "第一行第二行第三行", bold: "第一行第二行第三行" });
});
