import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { mockBridge, ready, saved, importTestTemplates } from "./helpers";
import type { SemanticBundle, SemanticPlan } from "../../app/studio/semantic-agent";

async function wordDocument(extra = "") {
  const zip = new JSZip();
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=", "base64");
  zip.file("word/media/photo.png", image);
  zip.file("word/styles.xml", `<w:styles xmlns:w="urn:word"><w:style w:styleId="H1"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="48"/><w:b/></w:rPr></w:style><w:style w:styleId="H2"><w:name w:val="Heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`);
  zip.file("word/numbering.xml", `<w:numbering xmlns:w="urn:word"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships><Relationship Id="photo" Target="media/photo.png"/><Relationship Id="link" Target="https://example.com/signup" TargetMode="External"/></Relationships>`);
  zip.file("word/document.xml", `<w:document xmlns:w="urn:word" xmlns:r="urn:relationships" xmlns:a="urn:drawing"><w:body>
    <w:p><w:pPr><w:pStyle w:val="H1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>校园开放日</w:t></w:r></w:p>
    <w:p><w:r><w:t>前言原文。</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>活动安排</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>图片前</w:t><w:drawing><a:blip r:embed="photo"/></w:drawing><w:t>图片后</w:t><w:br/><w:t>换行后</w:t></w:r><w:hyperlink r:id="link"><w:r><w:rPr><w:i/></w:rPr><w:t>报名链接</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:drawing><a:blip r:embed="photo"/></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>图注：校园现场</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>填写信息</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>确认报名</w:t></w:r></w:p>${extra}
  </w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
function planFor(source: SemanticBundle["request"]["source"]): SemanticPlan {
  const ids = source.blocks.map((item) => item.id);
  return { schema: "opslion/semantic-plan/v1", nodes: [
    { type: "article_title", source_ids: [ids[0]] }, { type: "paragraph", source_ids: [ids[1]] },
    { type: "heading1", source_ids: [ids[2]] }, { type: "paragraph", source_ids: [ids[3]] },
    { type: "image", source_ids: [ids[4]] }, { type: "paragraph", source_ids: [ids[5]] },
    { type: "image", source_ids: [ids[6], ids[7]] }, { type: "ol", source_ids: [ids[8], ids[9]] },
  ] };
}

test("model Word semantics preserve source order, formatting, image occurrences and numbering in the selected template", async ({ page }, testInfo) => {
  await mockBridge(page); await ready(page);
  await page.getByRole("button", { name: "模板库", exact: true }).click(); await importTestTemplates(page);
  await page.getByRole("button", { name: /测试章节/ }).click();
  await page.getByRole("button", { name: "金色", exact: true }).click();
  await page.getByRole("button", { name: /套用到当前文章/ }).click();
  let captured: SemanticBundle["request"] | undefined;
  await page.route("**/local-api/agent/plan", async (route) => {
    captured = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, plan: planFor(captured!.source), model: "mock-semantic", latency_ms: 10 } });
  });
  await page.getByLabel("模型解析 Word 文件", { exact: true }).setInputFiles({ name: "来源.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await wordDocument() });
  await expect(page.getByRole("heading", { name: "审核文案结构" })).toBeVisible();
  expect(captured!.task).toBe("parse_article_semantics");
  expect(captured!.source.schema).toBe("opslion/word-snapshot/v1");
  expect(JSON.stringify(captured)).not.toContain("base64");
  expect(captured!.source.blocks[0].clues.style_name).toBe("Heading 1");
  expect(captured!.source.blocks[2].clues.style_name).toBe("Heading 2");
  await expect(page.locator(".preview-content")).not.toContainText("校园开放日");
  await page.getByRole("button", { name: "应用这个计划" }).click();
  await expect(page.locator(".preview-content h1")).toHaveText("校园开放日");
  await expect(page.locator(".preview-content img")).toHaveCount(2);
  await expect(page.locator(".preview-content ol")).toHaveAttribute("start", "7");
  await expect(page.locator(".preview-content strong").filter({ hasText: "图片前" })).toBeVisible();
  await expect(page.locator('.preview-content a[href="https://example.com/signup"] em')).toHaveText("报名链接");
  await saved(page); await page.reload(); await saved(page);
  await expect(page.locator(".layout-style-panel")).toContainText("测试章节");
  await expect(page.getByRole("button", { name: "金色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("word-semantics-applied.png") });
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: /^下载独立 HTML/ }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect(html.indexOf("图片前")).toBeLessThan(html.indexOf("data:image"));
  expect(html.indexOf("data:image")).toBeLessThan(html.indexOf("图片后"));
  expect(html).toContain("图注：校园现场"); expect(html).toContain('start="7"');
});

test("semantic results reject missing sources and unsupported Word content without changing the article", async ({ page }) => {
  await mockBridge(page); await ready(page);
  let calls = 0;
  await page.route("**/local-api/agent/plan", async (route) => {
    calls++;
    const request = route.request().postDataJSON() as SemanticBundle["request"];
    const plan = planFor(request.source); plan.nodes.pop();
    await route.fulfill({ json: { plan, model: "mock", latency_ms: 1 } });
  });
  const before = await page.locator(".preview-content").innerHTML();
  await page.getByLabel("模型解析 Word 文件", { exact: true }).setInputFiles({ name: "合成.docx", mimeType: "application/octet-stream", buffer: await wordDocument() });
  await expect(page.locator(".toast")).toContainText("遗漏");
  expect(await page.locator(".preview-content").innerHTML()).toBe(before);
  await page.getByLabel("模型解析 Word 文件", { exact: true }).setInputFiles({ name: "表格.docx", mimeType: "application/octet-stream", buffer: await wordDocument("<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格数据</w:t></w:r></w:p></w:tc></w:tr></w:tbl>") });
  await expect(page.locator(".toast")).toContainText("表格"); expect(calls).toBe(1);
  expect(await page.locator(".preview-content").innerHTML()).toBe(before);
});

test("unconfigured Word import uses the shared parser and never requests a model", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/agent/config", (route) => route.fulfill({ json: { config: { configured: false, model: "", base_url: "", temperature: 0, api_key_saved: false, api_key_source: "none" } } }));
  let calls = 0; await page.route("**/local-api/agent/plan", (route) => { calls++; return route.fulfill({ json: {} }); });
  await ready(page);
  await page.locator('input[accept^=".docx"]').setInputFiles("tests/fixtures/article.docx");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toHaveText("回归测试文章");
  await expect(page.locator(".preview-content img")).toHaveCount(1);
  expect(calls).toBe(0);
});

test("editor semantic plans keep rich text and reject fabricated layout fields and false lists", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest; const project = api.createDefaultProject();
    const bundle = api.semanticAgent.createEditorSemanticRequest(project);
    const plan = { schema: "opslion/semantic-plan/v1", nodes: bundle.request.source.blocks.map((b, i) => ({ type: i ? "paragraph" : "article_title", source_ids: [b.id] })) };
    const article = api.semanticAgent.applySemanticPlan(plan, bundle, "check");
    const reject = (value: unknown) => { try { api.semanticAgent.applySemanticPlan(value, bundle, "check"); return false; } catch { return true; } };
    return { schema: article.schema, extra: reject({ ...plan, html: "<p>替换</p>" }), list: reject({ ...plan, nodes: plan.nodes.map((n, i) => i === 1 ? { ...n, type: "ol" } : n) }), reordered: reject({ ...plan, nodes: [...plan.nodes].reverse() }) };
  });
  expect(result).toEqual({ schema: "opslion.article/v1", extra: true, list: true, reordered: true });
});
