import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { ready, mockBridge, saved } from "./helpers";

async function richWord() {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="urn:word" xmlns:r="urn:rel"><w:body>
    <w:p><w:r><w:t>核对活动通知</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>报名信息</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">请于 </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="CC2244"/></w:rPr><w:t>10月1日</w:t></w:r><w:r><w:t> 前报名。</w:t></w:r><w:hyperlink r:id="link"><w:r><w:t>报名链接</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>自备材料</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>时间</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>星期五</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`);
  zip.file("word/numbering.xml", '<w:numbering xmlns:w="urn:word"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>');
  zip.file("word/_rels/document.xml.rels", '<Relationships><Relationship Id="link" Target="https://example.com/new-registration" TargetMode="External"/></Relationships>');
  return zip.generateAsync({ type: "nodebuffer" });
}

test("shared Word parsing preserves rich content and exposes a local table conversion", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async (bytes) => {
    const api = window.opTest;
    const imported = await api.importDocx(new File([new Uint8Array(bytes)], "核对.docx"));
    const article = api.wordConversion.wordArticle(imported.bundle, "word", { "table-1": "text" });
    const html = api.layoutEngine.compileArticle(article, api.layoutEngine.testTemplates[0]).html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { title: api.layoutEngine.articleTitle(article), heading: article.nodes[1].type, bold: doc.querySelector("strong")?.textContent, link: doc.querySelector("a")?.getAttribute("href"), start: doc.querySelector("ol")?.getAttribute("start"), issues: api.wordConversion.wordConversions(imported.bundle.request.source.blocks), text: doc.body.textContent };
  }, [...await richWord()]);
  expect(result).toMatchObject({ title: "核对活动通知", heading: "heading2", bold: "10月1日", link: "https://example.com/new-registration", start: "4" });
  expect(result.issues).toHaveLength(1); expect(result.issues[0].location).toContain("表格 1");
  expect(result.text).toContain("第 1 行 · 第 2 列：星期五");
});

test("native scoped edits follow semantic emphasis and update the link target", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest; const s = api.submission; const project = api.createDefaultProject(); project.mode = "clone";
    project.cloneTemplate = api.analyzeTemplateHtml('<section><p>请于 <strong style="color:#cc2244">9月20日</strong> 前报名。</p><p><a href="https://example.com/old">报名地址</a></p></section>', "紫色模板");
    const state = s.captureBaseline(s.emptySubmission("update"), project);
    const date = state.base_article!.nodes[1], link = state.base_article!.nodes[2];
    const assembled = s.assembleSubmission(state, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: project.id, changes: [
      { op: "set_content", target_node_id: date.id, content: [{ text: "请务必于 " }, { text: "10月1日", marks: ["bold"] }, { text: " 前报名。" }] },
      { op: "set_content", target_node_id: link.id, content: [{ href: "https://example.com/new", content: [{ text: "新报名地址" }] }] },
    ], image_requests: [], pending: [] });
    const next = s.commitSubmission(project, assembled); const html = api.renderProject(next); const doc = new DOMParser().parseFromString(html, "text/html");
    return { text: doc.querySelector("p")?.textContent, emphasis: doc.querySelector("strong")?.textContent, color: doc.querySelector("strong")?.style.color, link: doc.querySelector("a")?.getAttribute("href"), mode: next.mode };
  });
  expect(result).toEqual({ text: "请务必于 10月1日 前报名。", emphasis: "10月1日", color: "rgb(204, 34, 68)", link: "https://example.com/new", mode: "clone" });
});

test("rebinding an image updates the rendered draft and keeps independent manual text", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission; let state = s.emptySubmission();
    state.assets = ["A", "B"].map((id) => ({ id, storage_ref: `https://example.com/${id}.png`, media_type: "image/png", origins: [], aliases: [] }));
    state = s.assembleSubmission(state, { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "稿件" }], source_ids: [] }, { id: "p", type: "paragraph", content: [{ text: "已审文案" }], source_ids: [] }, { id: "i", type: "image_ref", request_id: "r", source_ids: [] }] }, image_requests: [{ id: "r", purpose: "配图", selector: { kind: "file", relative_path: "missing.png" }, source_ids: [] }], pending: [] });
    state = s.bindAsset(state, "r", "A"); const article = s.projectDraft(state); const paragraph = article.nodes[1]; if ("content" in paragraph) paragraph.content = [{ text: "人工修正保留" }];
    state = s.syncDraftEdits(state, article); state = s.bindAsset(state, "r", "B");
    const parsed = api.submission.submissionSchema.parse(state); const draft = s.projectDraft(parsed);
    return { text: "content" in draft.nodes[1] && api.layoutEngine.richTextToPlain(draft.nodes[1].content), image: draft.nodes[2], binding: parsed.bindings.r };
  });
  expect(result.text).toBe("人工修正保留"); expect(result.image).toMatchObject({ type: "image", src: "https://example.com/B.png" }); expect(result.binding).toMatchObject({ asset_id: "B" });
});

test("missing QR survives a new scoped update and continues to block formal export", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission; const project = api.createDefaultProject();
    const first = s.assembleSubmission(s.emptySubmission(), { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "稿件" }], source_ids: [] }, { id: "p", type: "paragraph", content: [{ text: "旧日期" }], source_ids: [] }, { id: "qr", type: "image_ref", request_id: "qr-request", source_ids: [] }] }, image_requests: [{ id: "qr-request", purpose: "报名二维码", selector: { kind: "file", relative_path: "qr.png" }, source_ids: [] }], pending: [] });
    const current = s.commitSubmission(project, first);
    const captured = s.captureBaseline(s.emptySubmission("update"), current); const before = s.submissionBlockers(captured);
    const updated = s.assembleSubmission(captured, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: current.id, changes: [{ op: "set_content", target_node_id: "p", content: [{ text: "新日期" }] }], image_requests: [], pending: [] });
    const next = s.commitSubmission(current, updated); const html = api.renderProject(next);
    return { before, after: s.submissionBlockers(updated), nodes: updated.draft!.nodes, html };
  });
  expect(result.before).toContain("待补素材：报名二维码"); expect(result.after).toContain("待补素材：报名二维码"); expect(result.nodes[2].type).toBe("image_ref"); expect(result.html).toContain("新日期");
});

test("new submission retains historical template and unplaced required text blocks delivery", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const api = window.opTest, s = api.submission; const project = api.createDefaultProject(); project.mode = "clone";
    project.cloneTemplate = api.analyzeTemplateHtml('<section style="color:#765087"><h1>旧标题</h1><p>旧正文</p></section>', "指定紫色模板");
    const submission = s.assembleSubmission(s.emptySubmission(), { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, type: i ? "paragraph" : "article_title", content: [{ text: `必需文案${i}` }], source_ids: [] })) }, image_requests: [], pending: [] });
    const next = s.commitSubmission(project, submission); const notices: string[] = [];
    const blocked = await api.createExportActions(next, api.renderProject(next), [], (v) => notices.push(v), () => {}).downloadBridge();
    let resolved = next.cloneTemplate!;
    for (const item of [...resolved.unplacedContent!]) resolved = api.localFill.placeUnplacedContent(resolved, item.id);
    const html = api.renderProject({ ...next, cloneTemplate: resolved });
    return { mode: next.mode, name: next.cloneTemplate!.name, pending: next.cloneTemplate!.unplacedContent?.length, blocked, notices, remaining: resolved.unplacedContent?.length, count: Array.from({ length: 13 }, (_, i) => html.includes(`必需文案${i}`)).filter(Boolean).length };
  });
  expect(result).toMatchObject({ mode: "clone", name: "指定紫色模板", pending: 11, blocked: false, remaining: 0, count: 13 }); expect(result.notices[0]).toContain("文案未排入");
});

test("manual poster and photo pair survive compilation alongside a local paragraph variant", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest; const template = api.layoutEngine.testTemplates[1];
    const article = api.layoutEngine.parsedArticleSchema.parse({ schema: "opslion.article/v1", id: "manual", nodes: [{ id: "t", type: "article_title", content: [] }, { id: "p", type: "paragraph", content: [{ text: "单独强调" }] }, ...["poster", "a", "b"].map((id) => ({ id, type: "image", src: `https://example.com/${id}.png`, group: id === "poster" ? "poster" : "pair" }))] });
    const compiled = api.layoutEngine.compileArticle(article, template, null, {}, { nodeVariants: { p: "body-emphasis" }, native: true });
    const list: string[] = []; const walk = (p: typeof compiled.plan.page) => { list.push(p.component); Object.values(p.regions).forEach((items) => items.forEach(walk)); }; walk(compiled.plan.page);
    const stored = api.layoutEngine.layoutStateSchema.parse({ ...api.layoutEngine.createLayoutState(article, template), nodeVariants: { p: "body-emphasis" } });
    return { list, variants: stored.nodeVariants, groups: stored.article.nodes.filter((n) => n.type === "image").map((n) => n.group) };
  });
  expect(result.list).toContain("body-emphasis"); expect(result.list).toContain("image-pair"); expect(result.list).not.toContain("image-triple"); expect(result.groups).toEqual(["poster", "pair", "pair"]);
});

test("Word replace remains undoable and keeps a recoverable project version", async ({ page }, testInfo) => {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async () => { const api = window.opTest; const p = api.createDefaultProject(); p.layout = api.layoutEngine.createLayoutState(api.layoutEngine.adaptLegacyArticle(p.content, p.id), api.layoutEngine.testTemplates[0]); await api.saveProject(p); });
  await ready(page); const title = page.getByRole("textbox", { name: "文章标题", exact: true }); await title.fill("手工审定标题"); await title.blur();
  await page.locator('input[accept^=".docx"]').setInputFiles({ name: "修订稿.docx", mimeType: "application/octet-stream", buffer: await richWord() });
  await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeDisabled();
  await page.getByLabel("处理 table-1").selectOption("text"); await page.getByLabel("Word 导入位置").selectOption("replace");
  await page.screenshot({ path: testInfo.outputPath("word-import-review.png"), fullPage: true });
  await page.getByRole("button", { name: "确认导入", exact: true }).click(); await expect(title).toHaveText("核对活动通知");
  await page.getByRole("button", { name: "撤销编辑", exact: true }).click(); await expect(title).toHaveText("手工审定标题"); await saved(page);
  const versions = await page.evaluate(async () => (await window.opTest.loadProjects()).filter((p) => p.name.includes("Word 导入前")));
  expect(versions).toHaveLength(1);
});

test("disabling a source preserves approved content and requires a scoped review", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission; const base = s.emptySubmission();
    base.files = [{ id: "file", relative_path: "原稿.docx", media_type: "docx", role: "main" }];
    base.documents = [{ id: "file", file_id: "file", name: "原稿.docx", warnings: [], annotations: [], blocks: [{ id: "source", kind: "paragraph", content: [{ text: "已批准的标题", marks: ["bold"] }], clues: {} }] }]; base.main_document_ids = ["file"];
    const assembled = s.assembleSubmission(base, { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", source_ids: ["source"], content: [{ text: "已批准的标题" }] }] }, image_requests: [], pending: [{ id: "layout", kind: "layout_preference", message: "海报单独一行", source_ids: [], candidate_ids: [] }] });
    const disabled = s.removeSubmissionFile(assembled, "file", true);
    const project = s.commitSubmission(api.createDefaultProject(), disabled);
    const edit = s.captureBaseline(s.emptySubmission("update"), project); edit.user_instructions = "只修改日期";
    const request = s.submissionRequest(edit);
    return { draft: disabled.draft, original: assembled.draft, pending: s.submissionBlockers(disabled), activeDocuments: request.documents.length, activeFiles: request.files.length, inherited: edit.files.length };
  });
  expect(result.draft).toEqual(result.original); expect(result.pending).toContain("海报单独一行"); expect(result.pending.some((p) => p.includes("已停用"))).toBe(true);
  expect(result).toMatchObject({ activeDocuments: 0, activeFiles: 0, inherited: 1 });
});

test("embedded images recommend Bridge before offering clipboard paths", async ({ page }, testInfo) => {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async () => {
    const api = window.opTest; const project = api.createDefaultProject();
    project.layout = api.layoutEngine.createLayoutState({ schema: "opslion.article/v1", id: project.id, nodes: [{ id: "t", type: "article_title", content: [{ text: "活动交付核对" }] }, { id: "i", type: "image", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=", alt: "Word 内嵌图片" }] }, api.layoutEngine.testTemplates[0]);
    await api.saveProject(project);
  });
  await ready(page); await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  await expect(page.locator(".recommended-export")).toContainText("使用 Bridge 导入秀米");
  await expect(page.getByRole("button", { name: /^兼容模式复制/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^打开安全复制页/ })).toBeDisabled();
  await expect(page.locator(".export-steps")).toContainText("保存成功");
  await page.screenshot({ path: testInfo.outputPath("bridge-delivery-options.png"), animations: "disabled" });
});

test("historical template reserves a missing image as an image binding across scoped text updates", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission; const p = api.createDefaultProject(); p.mode = "clone";
    p.cloneTemplate = api.analyzeTemplateHtml('<section><h1>原题</h1><p>原文</p><img src="https://example.com/old.png"/><p>结束</p></section>', "固定模板");
    p.cloneTemplate.slots.filter((slot) => slot.kind === "image").forEach((slot) => { slot.role = "content_image"; });
    const first = s.assembleSubmission(s.emptySubmission(), { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "活动" }], source_ids: [] }, { id: "p", type: "paragraph", content: [{ text: "日期" }], source_ids: [] }, { id: "qr", type: "image_ref", request_id: "r", source_ids: [] }, { id: "end", type: "paragraph", content: [{ text: "结语" }], source_ids: [] }] }, image_requests: [{ id: "r", purpose: "报名码", selector: { kind: "file", relative_path: "qr.png" }, source_ids: [] }], pending: [] });
    const initial = s.commitSubmission(p, first); const capture = s.captureBaseline(s.emptySubmission("update"), initial);
    const body = capture.base_article!.nodes.find((node) => "content" in node && api.layoutEngine.richTextToPlain(node.content) === "日期")!;
    const updated = s.assembleSubmission(capture, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: p.id, changes: [{ op: "set_content", target_node_id: body.id, content: [{ text: "新日期" }] }], image_requests: [], pending: [] });
    const partial = s.commitSubmission(initial, updated);
    const assets = [{ id: "qr-asset", storage_ref: "https://example.com/new-qr.png", media_type: "image/png", origins: [{ file_id: "qr-file", relative_path: "qr.png" }], aliases: [] }];
    const bound = s.resolveAssets({ ...updated, assets: [...updated.assets, ...assets] }); const complete = s.commitSubmission(partial, bound);
    const doc = new DOMParser().parseFromString(api.renderProject(complete), "text/html");
    return { blockers: s.submissionBlockers(bound), text: doc.body.textContent, image: doc.querySelector("img")?.getAttribute("src"), kind: first.draft?.nodes[2].type, capturedKinds: capture.base_draft?.map((n) => n.type), pendingKind: initial.submission?.native_bindings?.qr.kind };
  });
  expect(result).toMatchObject({ blockers: [], image: "https://example.com/new-qr.png", pendingKind: "image" });
  expect(result.text).toContain("新日期"); expect(result.text).toContain("结语"); expect(result.capturedKinds?.indexOf("image_ref")).toBe(3);
});

test("a pending scoped update accepts late images and retains manual edits before model review", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission;
    const first = s.assembleSubmission(s.emptySubmission(), { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "已审稿件" }], source_ids: [] }, { id: "p", type: "paragraph", content: [{ text: "已审正文" }], source_ids: [] }, { id: "qr", type: "image_ref", request_id: "r", source_ids: [] }] }, image_requests: [{ id: "r", purpose: "二维码", selector: { kind: "file", relative_path: "qr.png" }, source_ids: [] }], pending: [] });
    const initial = s.commitSubmission(api.createDefaultProject(), first);
    let pending = s.captureBaseline(s.emptySubmission("update"), initial);
    pending.assets.push({ id: "a", storage_ref: "https://example.com/qr.png", media_type: "image/png", origins: [], aliases: [] });
    pending = s.bindAsset(pending, "r", "a");
    const filled = s.commitSubmission(initial, pending);
    const manual = structuredClone(filled.layout!.article);
    const paragraph = manual.nodes.find((n) => n.id === "p")!; if ("content" in paragraph) paragraph.content = [{ text: "已人工修正的正文" }];
    pending = s.syncDraftEdits(filled.submission!, manual); pending.user_instructions = "仅修改标题";
    const saved = s.submissionSchema.parse(pending); const blockers = s.submissionBlockers(saved);
    const reviewed = s.assembleSubmission(saved, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: initial.id, changes: [{ op: "set_content", target_node_id: "t", content: [{ text: "修改后的标题" }] }], image_requests: [], pending: [] });
    const complete = s.commitSubmission(filled, reviewed);
    return { applied: filled.submission!.applied, image: filled.layout!.article.nodes[2], blockers, text: api.renderProject(complete), remaining: s.submissionBlockers(complete.submission!) };
  });
  expect(result).toMatchObject({ applied: false, image: { type: "image", src: "https://example.com/qr.png" }, blockers: ["本次局部修改尚未审核应用"], remaining: [] });
  expect(result.text).toContain("已人工修正的正文"); expect(result.text).toContain("修改后的标题");
});

test("cancelling a replacement keeps the original after new assets arrive and the next update starts", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission; const original = api.createDefaultProject(); original.mode = "clone";
    original.cloneTemplate = api.analyzeTemplateHtml('<section><h1>已审稿件</h1><img src="https://example.com/approved.png"/><p>结语</p></section>', "历史模板");
    original.cloneTemplate.slots.filter((slot) => slot.kind === "image").forEach((slot) => { slot.role = "content_image"; });
    const first = s.captureBaseline(s.emptySubmission("update"), original); const imageId = first.base_article!.nodes.find((n) => n.type === "image")!.id;
    const replacement = s.assembleSubmission(first, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: original.id, changes: [{ op: "set_image", target_node_id: imageId, request_id: "r" }], image_requests: [{ id: "r", purpose: "新版配图", selector: { kind: "file", relative_path: "new.png" }, source_ids: [] }], pending: [] });
    const current = s.commitSubmission(original, replacement);
    const captured = s.captureBaseline(s.emptySubmission("update"), current);
    const count = captured.base_draft!.filter((n) => n.type === "image" || n.type === "image_ref").length;
    const cancelled = s.cancelImageRequest(captured, "r");
    cancelled.assets.push({ id: "late", storage_ref: "https://example.com/new.png", media_type: "image/png", origins: [{ file_id: "new", relative_path: "new.png" }], aliases: [] });
    const kept = s.commitSubmission(current, s.resolveAssets(cancelled));
    const next = s.resolveAssets(s.captureBaseline(s.emptySubmission("update"), kept));
    const doc = new DOMParser().parseFromString(api.renderProject(s.commitSubmission(kept, next)), "text/html");
    return { count, source: doc.querySelector("img")?.getAttribute("src"), images: doc.querySelectorAll("img").length, blockers: s.submissionBlockers(next) };
  });
  expect(result).toEqual({ count: 1, source: "https://example.com/approved.png", images: 1, blockers: [] });
});

test("starting a scoped update keeps the missing image controls and accepts a manual binding in the UI", async ({ page }) => {
  await mockBridge(page); await ready(page, true);
  await page.evaluate(async () => {
    const api = window.opTest, s = api.submission;
    const state = s.assembleSubmission(s.emptySubmission(), { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "已审稿件" }], source_ids: [] }, { id: "p", type: "paragraph", content: [{ text: "独立修订正文" }], source_ids: [] }, { id: "qr", type: "image_ref", request_id: "r", source_ids: [] }] }, image_requests: [{ id: "r", purpose: "报名二维码", selector: { kind: "description", text: "稍后确认二维码" }, source_ids: [] }], pending: [] });
    state.assets.push({ id: "a", storage_ref: "https://example.com/qr.png", media_type: "image/png", origins: [], aliases: [] });
    await api.saveProject(s.commitSubmission(api.createDefaultProject(), state));
  });
  await ready(page); await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await page.getByRole("button", { name: "开始新的局部修改", exact: true }).click();
  await page.getByRole("button", { name: "关闭交稿", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "交稿与素材", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "选择或补充图片", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除第 2 项", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "第 1 项内容", exact: true }).fill("这段手工修订继续保留");
  await expect(page.locator(".preview-content")).toContainText("这段手工修订继续保留");
  await saved(page);
  expect(await page.evaluate(async () => {
    const project = (await window.opTest.loadActiveProject())!;
    const node = project.submission?.base_draft?.find((n) => n.id === "p");
    return node && "content" in node ? window.opTest.layoutEngine.richTextToPlain(node.content) : node;
  })).toBe("这段手工修订继续保留");
  await page.getByRole("button", { name: "选择或补充图片", exact: true }).click();
  await page.getByLabel("绑定 报名二维码", { exact: true }).selectOption("a");
  await page.getByRole("button", { name: "关闭交稿", exact: true }).click();
  await expect(page.locator(".preview-content")).toContainText("这段手工修订继续保留");
  await expect(page.locator(".preview-content")).not.toContainText("待补图片");
  await expect(page.locator(".preview-content img")).toHaveAttribute("src", /qr\.png/);
});
