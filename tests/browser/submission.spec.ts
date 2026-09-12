import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { ready, mockBridge, saved, importTestTemplates } from "./helpers";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=";
test("cancelling replacement retains the old image and source numbering survives assembly", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((pixel) => {
    const api = window.opTest; const s = api.submission;
    const project = api.createDefaultProject();
    project.layout = api.layoutEngine.createLayoutState({ schema: "opslion.article/v1", id: project.id, nodes: [{ id: "t", type: "article_title", content: [] }, { id: "i", type: "image", src: `data:image/png;base64,${pixel}`, alt: "原图", caption: [{ text: "原图注" }] }] }, api.layoutEngine.testTemplates[0]);
    const state = s.captureBaseline(s.emptySubmission("update"), project);
    const draft = s.assembleSubmission(state, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: project.id, changes: [{ op: "set_image", target_node_id: "i", request_id: "r" }], image_requests: [{ id: "r", purpose: "换新版图", selector: { kind: "file", relative_path: "missing.png" }, source_ids: [] }], pending: [] });
    const cancelled = s.cancelImageRequest(draft, "r");
    const source = s.emptySubmission(); source.documents = [{ id: "d", file_id: "d", name: "main.docx", annotations: [], warnings: [], blocks: [{ id: "h", kind: "paragraph", content: [{ text: "报名说明", marks: ["bold"] }], clues: { numbering: { label: "3." } } }] }];
    const heading = s.sourceNode({ id: "heading", type: "heading1", source_ids: ["h"] }, source);
    return { image: s.projectDraft(cancelled).nodes[1], original: project.layout.article.nodes[1], pending: s.submissionBlockers(cancelled), heading };
  }, pixel);
  expect(result.image).toEqual(result.original); expect(result.pending).toEqual([]);
  expect(result.heading).toMatchObject({ content: [{ text: "3. " }, { text: "报名说明", marks: ["bold"] }] });
});

async function docx(texts: string[], comments = false) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="urn:word"><w:body>${texts.map((text, index) => `<w:p>${comments && index === 0 ? '<w:commentRangeStart w:id="0"/>' : ''}<w:r><w:t>${text}</w:t></w:r>${comments && index === 0 ? '<w:commentRangeEnd w:id="0"/>' : ''}</w:p>`).join("")}</w:body></w:document>`);
  if (comments) zip.file("word/comments.xml", '<w:comments xmlns:w="urn:word"><w:comment w:id="0"><w:p><w:r><w:t>此处沿用二维码</w:t></w:r></w:p></w:comment></w:comments>');
  return zip.generateAsync({ type: "nodebuffer" });
}

test("appendix images bind at publication positions, scoped labels do not guess, and unused assets are allowed", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((pixel) => {
    const api = window.opTest; const s = api.submission; const state = s.emptySubmission();
    state.main_document_ids = ["doc1"];
    state.documents = [{ id: "doc1", file_id: "doc1", name: "main.docx", warnings: [], annotations: [], blocks: [
      { id: "t", kind: "paragraph", content: [{ text: "标题" }], clues: {} },
      { id: "a", kind: "paragraph", content: [{ text: "实验结果见图3。" }], clues: {} },
      { id: "marker", kind: "paragraph", content: [{ text: "【美编：此处放图3】" }], clues: {} },
      { id: "b", kind: "paragraph", content: [{ text: "后续正文" }], clues: {} },
      { id: "appendix", kind: "paragraph", content: [{ text: "配图素材" }], clues: {} },
      { id: "occ", kind: "image", image_anchor_id: "occ", content: [], clues: {} },
    ] }];
    state.assets = [{ id: "a1", storage_ref: `data:image/png;base64,${pixel}`, media_type: "image/png", origins: [{ file_id: "doc1", relative_path: "main.docx", document_id: "doc1", occurrence_id: "occ" }], aliases: [] }, { id: "backup", storage_ref: `data:image/png;base64,${pixel}`, media_type: "image/png", origins: [{ file_id: "extra", relative_path: "备用.png" }], aliases: [] }];
    const plan = { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [
      { id: "title", type: "article_title", source_ids: ["t"] }, { id: "p-a", type: "paragraph", source_ids: ["a"] },
      { id: "use1", type: "image_ref", request_id: "r1", source_ids: ["marker"] }, { id: "p-b", type: "paragraph", source_ids: ["b"] },
    ] }, image_requests: [{ id: "r1", purpose: "图3", selector: { kind: "label", text: "图3", document_id: "doc1", section_source_id: "a" }, source_ids: ["marker"] }], asset_aliases: [{ asset_id: "a1", text: "图3", document_id: "doc1", section_source_id: "a" }], excluded_sources: [{ source_id: "appendix", role: "reference", reason: "素材附录标题不发表" }], pending: [] };
    const assembled = s.assembleSubmission(state, plan); const article = s.projectDraft(assembled);
    const missing = s.assembleSubmission(state, { ...plan, asset_aliases: [], image_requests: [{ ...plan.image_requests[0], selector: { kind: "file", relative_path: "not-there.png" } }] });
    const description = s.assembleSubmission({ ...state, assets: [state.assets[0]] }, { ...plan, asset_aliases: [], image_requests: [{ ...plan.image_requests[0], selector: { kind: "description", text: "合影" } }] });
    const html = api.layoutEngine.compileArticle(article, api.layoutEngine.testTemplates[0]).html;
    return { types: article.nodes.map((n) => n.type), original: html.includes("实验结果见图3。"), marker: html.includes("美编"), appendix: html.includes("配图素材"), ready: s.submissionBlockers(assembled), missing: s.unresolvedImages(missing).length, description: s.unresolvedImages(description).length, spare: assembled.assets.length };
  }, pixel);
  expect(result).toEqual({ types: ["article_title", "paragraph", "image", "paragraph"], original: true, marker: false, appendix: false, ready: [], missing: 1, description: 1, spare: 2 });
});

test("patches preserve unmentioned content and image metadata; retries and late assets never overwrite manual edits", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((pixel) => {
    const api = window.opTest; const s = api.submission;
    const base = api.createDefaultProject(); base.id = "base";
    base.layout = api.layoutEngine.createLayoutState({ schema: "opslion.article/v1", id: "base", nodes: [
      { id: "title", type: "article_title", content: [{ text: "旧稿" }] }, { id: "p1", type: "paragraph", content: [{ text: "旧报名信息", marks: ["bold"] }] },
      { id: "img1", type: "image", src: `data:image/png;base64,${pixel}`, alt: "原图", caption: [{ text: "原图注" }], link_url: "https://example.com/old" },
      { id: "p2", type: "paragraph", content: [{ text: "保留这段" }] }, { id: "img2", type: "image", src: `data:image/png;base64,${pixel}`, alt: "同资源另一次使用", caption: [] },
    ] }, api.layoutEngine.testTemplates[0]);
    const state = s.captureBaseline(s.emptySubmission("update"), base); state.user_instructions = "修改报名并换图";
    const plan = { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: "base", changes: [
      { op: "set_content", target_node_id: "p1", content: [{ text: "新报名信息", marks: ["bold"] }] },
      { op: "set_image", target_node_id: "img1", request_id: "new-image" },
      { op: "insert_nodes", anchor_node_id: "p2", position: "after", nodes: [{ id: "new-p", type: "paragraph", source_ids: ["user:instructions"], content: [{ text: "新增说明" }] }] },
    ], image_requests: [{ id: "new-image", purpose: "新版活动图", selector: { kind: "file", relative_path: "new.png" }, source_ids: ["user:instructions"] }], pending: [] };
    let draft = s.assembleSubmission(state, plan); const repeat = s.assembleSubmission(state, plan);
    const before = s.projectDraft(draft); before.nodes = before.nodes.map((n) => n.id === "p1" ? { id: n.id, type: "paragraph", content: [{ text: "用户手改后的报名" }] } : n);
    draft = s.syncDraftEdits(draft, before);
    const notifications: string[] = []; const project = { ...base, submission: draft, layout: { ...base.layout, article: s.projectDraft(draft) } };
    void api.createExportActions(project, "<p>reference</p>", [], (message) => notifications.push(message), () => {}).downloadBridge();
    const originalAssets = draft.assets.length;
    draft.assets.push({ id: "new", storage_ref: `data:image/png;base64,${pixel}`, media_type: "image/png", origins: [{ file_id: "f2", relative_path: "new.png" }], aliases: [] });
    draft = s.resolveAssets(draft); const ready = s.projectDraft(draft);
    const image = ready.nodes.find((n) => n.id === "img1");
    return { repeat: repeat.draft?.nodes.filter((n) => n.id === "new-p").length, untouched: JSON.stringify(ready.nodes.find((n) => n.id === "img2")) === JSON.stringify(base.layout.article.nodes[4]), text: ready.nodes.find((n) => n.id === "p1"), metadata: image?.type === "image" ? [image.alt, image.caption, image.link_url] : null, blocked: notifications.length, pending: s.submissionBlockers(draft).length, originalAssets };
  }, pixel);
  expect(result.repeat).toBe(1); expect(result.untouched).toBe(true); expect(result.blocked).toBe(1); expect(result.pending).toBe(0);
  expect(result.text).toMatchObject({ content: [{ text: "用户手改后的报名" }] });
  expect(result.metadata).toEqual(["原图", [{ text: "原图注" }], "https://example.com/old"]);
});

test("submission persistence retains pending locations, covers, reusable candidates and assets after deleting the source project", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async (pixel) => {
    const api = window.opTest; const s = api.submission;
    const base = api.createDefaultProject(); base.id = "source-project";
    base.layout = api.layoutEngine.createLayoutState({ schema: "opslion.article/v1", id: base.id, nodes: [{ id: "t", type: "article_title", content: [{ text: "源稿" }] }, { id: "qr", type: "image", src: `data:image/png;base64,${pixel}`, alt: "关注码", caption: [] }] }, api.layoutEngine.testTemplates[0]);
    await api.saveProject(base);
    const state = s.addArticleAssets(s.emptySubmission(), base.layout.article, "源稿"); state.user_instructions = "用旧二维码，封面稍后";
    const plan = { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", source_ids: ["user:instructions"], content: [{ text: "新稿" }] }, { id: "qr-use", type: "image_ref", request_id: "qr", source_ids: ["user:instructions"] }] }, image_requests: [{ id: "qr", purpose: "旧稿关注码", selector: { kind: "base_node", article_id: base.id, node_id: "qr" }, source_ids: [] }, { id: "cover", purpose: "封面", selector: { kind: "file", relative_path: "cover.png" }, source_ids: [] }], publishing: { cover_request_id: "cover" }, pending: [] };
    const submission = s.assembleSubmission(state, plan); const project = { ...api.createDefaultProject(), id: "new-project", submission, layout: api.layoutEngine.createLayoutState(s.projectDraft(submission), api.layoutEngine.testTemplates[0]) };
    await api.saveProject(project); await api.removeProject(base.id);
    const loaded = (await api.loadProjects()).find((p) => p.id === project.id)!;
    await api.saveReusableAssets([{ ...submission.assets[0], reusable: { scope_id: "campus", key: "follow" } }]);
    const reusable = await api.loadReusableAssets();
    return { src: loaded.layout!.article.nodes.filter((n) => n.type === "image")[0].src, pending: s.unresolvedImages(loaded.submission!).map((r) => r.id), cover: loaded.submission!.publishing.cover_request_id, reusable: reusable[0].reusable, schema: api.parseProjectFile({ project: loaded }).submission?.schema };
  }, pixel);
  expect(result.src).toContain("data:image/png;base64,"); expect(result.pending).toEqual(["cover"]); expect(result.cover).toBe("cover"); expect(result.reusable).toEqual({ scope_id: "campus", key: "follow" }); expect(result.schema).toBe("opslion/submission/v1");
});

test("native HTML and SVG content updates preserve wrappers, interactions and unrelated images", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((pixel) => {
    const api = window.opTest; const s = api.submission;
    const project = api.createDefaultProject(); project.id = "native"; project.mode = "clone";
    project.cloneTemplate = api.analyzeTemplateHtml(`<section style="border:2px solid #123456"><p>报名日期 <strong>2025年</strong></p><a href="https://example.com/image"><img src="data:image/png;base64,${pixel}" /></a><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><text x="20" y="30"><tspan>原生文字</tspan></text><rect id="tap" width="20" height="20"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="click" /></rect></svg></section>`, "原生稿");
    const state = s.captureBaseline(s.emptySubmission("update"), project); state.user_instructions = "换报名日期与原生文字";
    const text = state.base_article!.nodes.find((n) => n.type === "paragraph" && api.layoutEngine.richTextToPlain(n.content).includes("报名日期"))!;
    const svg = state.base_article!.nodes.find((n) => n.type === "paragraph" && api.layoutEngine.richTextToPlain(n.content).includes("原生文字"))!;
    const plan = { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: project.id, changes: [{ op: "set_content", target_node_id: text.id, content: [{ text: "报名日期 2026年" }] }, { op: "set_content", target_node_id: svg.id, content: [{ text: "更新原生文字" }] }], image_requests: [], pending: [] };
    const assembled = s.assembleSubmission(state, plan); const template = s.applyNativeDraft(project.cloneTemplate, assembled);
    const html = api.renderProject({ ...project, cloneTemplate: template, submission: assembled });
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { text: doc.body.textContent, svg: doc.querySelector("svg text")?.textContent, span: Boolean(doc.querySelector("svg tspan")), animation: Boolean(doc.querySelector("animate")), link: doc.querySelector("a img")?.parentElement?.getAttribute("href"), border: doc.querySelector("section")?.getAttribute("style"), images: doc.querySelectorAll("img").length };
  }, pixel);
  expect(result.text).toContain("2026年"); expect(result.svg).toBe("更新原生文字"); expect(result.span).toBe(true); expect(result.animation).toBe(true); expect(result.link).toBe("https://example.com/image"); expect(result.border).toContain("rgb(18, 52, 86)"); expect(result.images).toBe(1);
});

test("ZIP keeps separate document identities, relative paths and anchored comments", async ({ page }) => {
  const zip = new JSZip(); zip.file("A/主稿.docx", await docx(["文稿A"], true)); zip.file("B/备选.docx", await docx(["文稿B"])); zip.file("A/photo.png", Buffer.from(pixel, "base64")); zip.file("B/photo.png", Buffer.from(pixel, "base64")); zip.file("说明.txt", "备选文稿不发表"); zip.file("old.doc", "unsupported");
  const bytes = [...await zip.generateAsync({ type: "uint8array" })];
  await ready(page, true);
  const result = await page.evaluate(async (bytes) => {
    const s = window.opTest.submission; const state = await s.ingestFiles(s.emptySubmission(), [new File([new Uint8Array(bytes)], "交稿.zip")]);
    let rejected = false; try { s.submissionRequest(state); } catch { rejected = true; }
    return { files: state.files.map((f) => f.relative_path), ids: state.documents.flatMap((d) => d.blocks.map((b) => b.id)), main: state.main_document_ids, rejected, comment: state.documents[0].annotations[0], error: state.files.find((f) => f.relative_path === "old.doc")?.error };
  }, bytes);
  expect(result.files).toContain("A/photo.png"); expect(result.files).toContain("B/photo.png"); expect(new Set(result.ids).size).toBe(result.ids.length); expect(result.main).toEqual([]); expect(result.rejected).toBe(true); expect(result.comment.text).toBe("此处沿用二维码"); expect(result.comment.source_ids).toHaveLength(1); expect(result.error).toContain("不支持");
});

test("the UI assembles a missing-image draft, saves it, preserves manual text when a later ZIP supplies the image", async ({ page }, testInfo) => {
  const zip = new JSZip(); zip.file("main.docx", await docx(["交稿活动", "原始正文", "【图片：images/photo.png】"])); zip.file("备用.png", Buffer.from(pixel, "base64"));
  await mockBridge(page); await ready(page);
  let requests = 0;
  await page.route("**/local-api/agent/plan", async (route) => {
    requests++; const req = route.request().postDataJSON(); const doc = req.documents.find((d: { id: string }) => req.context.main_document_ids.includes(d.id));
    expect(req.task).toBe("prepare_submission"); expect(JSON.stringify(req)).not.toContain("base64");
    await route.fulfill({ json: { model: "synthetic", latency_ms: 1, plan: { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "title", type: "article_title", source_ids: [doc.blocks[0].id] }, { id: "body", type: "paragraph", source_ids: [doc.blocks[1].id] }, { id: "pending-image", type: "image_ref", request_id: "photo", source_ids: [doc.blocks[2].id] }] }, image_requests: [{ id: "photo", purpose: "活动合影", selector: { kind: "file", relative_path: "images/photo.png" }, source_ids: [doc.blocks[2].id] }], pending: [] } } });
  });
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await page.getByLabel("交稿文件", { exact: true }).setInputFiles({ name: "submission.zip", mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  await expect(page.locator(".submission-file")).toHaveCount(2);
  if (!await page.getByRole("button", { name: "理解并组装交稿", exact: true }).isVisible()) await page.getByText("高级 · 理解材料关系与局部修改", { exact: true }).click(); await page.getByRole("button", { name: "理解并组装交稿", exact: true }).click(); await expect(page.locator(".submission-review")).toBeVisible();
  await page.getByRole("button", { name: "应用组装结果", exact: true }).click();
  await expect(page.locator(".preview-content")).toContainText("待补图片：活动合影"); await expect(page.locator(".preview-content img")).toHaveCount(0);
  await page.getByRole("textbox", { name: "第 1 项内容", exact: true }).fill("后补前人工改好的正文"); await saved(page);
  await page.reload(); await saved(page); await expect(page.locator(".preview-content")).toContainText("后补前人工改好的正文");
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await expect(page.locator(".submission-pending")).toHaveCount(1); await expect(page.getByRole("dialog", { name: "交稿与素材" })).toHaveCSS("opacity", "1"); await page.screenshot({ path: testInfo.outputPath("submission-pending-desktop.png"), animations: "disabled" });
  expect(await page.locator(".submission-modal").evaluate((el) => el.getBoundingClientRect().width <= el.parentElement!.clientWidth + 1)).toBe(true);
  const supplement = new JSZip(); supplement.file("images/photo.png", Buffer.from(pixel, "base64"));
  await page.getByLabel("交稿文件", { exact: true }).setInputFiles({ name: "补图.zip", mimeType: "application/zip", buffer: await supplement.generateAsync({ type: "nodebuffer" }) });
  await expect(page.locator(".submission-pending")).toHaveCount(0);
  await page.getByRole("button", { name: "继续编辑文章", exact: true }).click();
  await expect(page.locator(".preview-content img")).toHaveCount(1); await expect(page.locator(".preview-content")).toContainText("后补前人工改好的正文");
  await expect(page.locator(".preview-content")).not.toContainText("待补图片"); expect(requests).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "交稿与素材" })).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("submission-mobile.png"), animations: "disabled" });
  expect(await page.locator(".submission-modal").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("UI updates only selected text and derives a separate project without changing its source", async ({ page }) => {
  await mockBridge(page); await ready(page);
  await page.getByRole("button", { name: "模板库", exact: true }).click(); await importTestTemplates(page); await page.getByRole("button", { name: /套用到当前文章/ }).click();
  await saved(page);
  const originalId = await page.evaluate(async () => (await window.opTest.loadActiveProject())!.id);
  let targetId = "";
  await page.route("**/local-api/agent/plan", async (route) => {
    const request = route.request().postDataJSON(); const target = request.base_article.nodes.find((n: { type: string }) => n.type === "paragraph"); targetId = target.id;
    await route.fulfill({ json: { model: "synthetic", latency_ms: 1, plan: { schema: "opslion/submission-plan/v1", mode: request.context.mode, base_article_id: request.context.base_article_id, changes: [{ op: "set_content", target_node_id: target.id, content: [{ text: request.context.mode === "derive" ? "派生稿的新内容" : "只修改这一段" }] }], image_requests: [], pending: [] } } });
  });
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click(); await page.getByRole("button", { name: "修改当前稿", exact: true }).click();
  await page.getByLabel("交稿要求", { exact: true }).fill("只修改第一段，其余保留"); if (!await page.getByRole("button", { name: "理解并组装交稿", exact: true }).isVisible()) await page.getByText("高级 · 理解材料关系与局部修改", { exact: true }).click(); await page.getByRole("button", { name: "理解并组装交稿", exact: true }).click();
  await page.getByRole("button", { name: "应用组装结果", exact: true }).click(); await expect(page.locator(".preview-content")).toContainText("只修改这一段"); await saved(page);
  expect(await page.evaluate(async () => (await window.opTest.loadActiveProject())!.id)).toBe(originalId);
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click(); await page.getByRole("button", { name: "开始新的局部修改", exact: true }).click();
  await page.getByRole("button", { name: "基于旧稿新建", exact: true }).click(); await page.getByLabel("交稿要求", { exact: true }).fill("复制成新一期，只换第一段");
  if (!await page.getByRole("button", { name: "理解并组装交稿", exact: true }).isVisible()) await page.getByText("高级 · 理解材料关系与局部修改", { exact: true }).click(); await page.getByRole("button", { name: "理解并组装交稿", exact: true }).click(); await page.getByRole("button", { name: "应用组装结果", exact: true }).click();
  await expect(page.locator(".preview-content")).toContainText("派生稿的新内容"); await saved(page);
  const states = await page.evaluate(async ({ originalId, targetId }) => { const all = await window.opTest.loadProjects(); const active = await window.opTest.loadActiveProject(all); return { id: active!.id, source: all.find((p) => p.id === originalId)!.layout!.article.nodes.find((n) => n.id === targetId) }; }, { originalId, targetId });
  expect(states.id).not.toBe(originalId); expect(states.source).toMatchObject({ content: [{ text: "只修改这一段" }] });
});
