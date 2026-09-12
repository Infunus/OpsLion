import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { ready, saved, mockBridge, config, importTestTemplates } from "./helpers";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=";
async function materialZip() {
  const word = new JSZip();
  word.file("word/document.xml", '<w:document xmlns:w="urn:word" xmlns:r="urn:rel"><w:body><w:p><w:r><w:t>本地活动通知</w:t></w:r></w:p><w:p><w:r><w:t>已审正文</w:t></w:r><w:hyperlink r:id="link"><w:r><w:t>报名入口</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:t>【图片：图/现场.png】</w:t></w:r></w:p><w:p><w:r><w:t>无需变动的末段</w:t></w:r></w:p></w:body></w:document>');
  word.file("word/_rels/document.xml.rels", '<Relationships><Relationship Id="link" Target="https://example.com/register" TargetMode="External"/></Relationships>');
  const zip = new JSZip(); zip.file("主稿.docx", await word.generateAsync({ type: "nodebuffer" })); zip.file("图/现场.png", Buffer.from(pixel, "base64"));
  return zip.generateAsync({ type: "nodebuffer" });
}
async function localOnly(page: Page, configured = false) {
  const requests: string[] = [];
  await mockBridge(page);
  await page.route("**/local-api/agent/config", (route) => route.fulfill({ json: { config: { ...config, configured, layout_ai_enabled: false } } }));
  await page.route(/\/local-api\/agent\/(plan|test)$/, async (route) => { requests.push(route.request().url()); await route.abort(); });
  return requests;
}

test("new template and Word ZIP automatically produce an exportable draft with zero model calls", async ({ page }, info) => {
  const requests = await localOnly(page); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message)); await ready(page);
  await expect(page.getByLabel("排版执行方式")).toHaveValue("local");
  const template = await page.evaluate(() => { const t = window.opTest.layoutEngine.publishTemplate(window.opTest.layoutEngine.testTemplates[1]); t.id = "new-offline-template"; t.name = "新导入活动模板"; return t; });
  await page.getByRole("button", { name: "模板库", exact: true }).click();
  await page.getByLabel("导入文章模板包文件").setInputFiles({ name: "new.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)) });
  await page.getByRole("button", { name: "选择新导入活动模板", exact: true }).click();
  await page.getByRole("button", { name: "套用到当前文章", exact: true }).click();
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await page.locator('input[aria-label="交稿文件"]').setInputFiles({ name: "交稿.zip", mimeType: "application/zip", buffer: await materialZip() });
  await expect(page.locator(".submission-file")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "一键排版", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".preview-content")).toContainText("已审正文");
  await expect(page.locator(".workflow-hint")).toContainText("自动排版已完成");
  await page.locator(".workflow-checks summary").click();
  await expect(page.locator(".workflow-check-results")).toContainText("模型请求 0 次");
  await page.locator(".workflow-checks summary").press("Escape");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const firstDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 Bridge 数据包", exact: true }).click();
  const firstPacket = JSON.parse(await readFile(await (await firstDownload).path(), "utf8"));
  expect(firstPacket.html).toContain("本地活动通知"); expect(firstPacket.html).toContain("已审正文"); expect(firstPacket.html).toContain("无需变动的末段");
  expect(firstPacket.html).toContain("https://example.com/register"); expect(firstPacket.assets).toHaveLength(1);
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("本地活动通知·人工修订");
  await page.getByRole("button", { name: "添加正文", exact: true }).click();
  await page.locator(".semantic-block .rich-text-input").last().fill("人工新增提醒");
  await page.getByRole("button", { name: "删除第 3 项", exact: true }).click();
  await page.getByRole("button", { name: "一键排版", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const mode = page.getByRole("group", { name: "画布模式", exact: true });
  await mode.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".preview-content")).toContainText("人工新增提醒");
  await expect(page.locator(".preview-content")).not.toContainText("无需变动的末段");
  await expect(page.locator(".preview-content [contenteditable]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("offline-preview.png"), animations: "disabled" });
  await mode.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("document", { name: "文章编辑画布", exact: true })).toContainText("人工新增提醒");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 Bridge 数据包", exact: true }).click();
  const packet = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
  expect(packet.schema).toBe("xiumi-bridge/v3"); expect(packet.html).toContain("人工新增提醒"); expect(packet.html).not.toContain("无需变动的末段"); expect(packet.html).toContain("https://example.com/register");
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await saved(page);
  await page.reload(); await saved(page);
  await expect(page.getByRole("button", { name: /人工校对|完成一校|完成二校/ })).toHaveCount(0);
  const stored = await page.evaluate(async () => { const p = (await window.opTest.loadActiveProject())!; return { template: p.layout?.template.id, edits: p.workflow?.edits }; });
  expect(stored.template).toBe("new-offline-template"); expect(stored.edits?.some((e) => e.origin === "human" && e.added.length)).toBe(true); expect(stored.edits?.some((e) => e.origin === "human" && e.deleted.length)).toBe(true);
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("成稿之后再次修改");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click(); await expect(page.getByRole("button", { name: "下载 Bridge 数据包", exact: true })).toBeEnabled();
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("a previously unseen HTML template can be filled and exported with AI disabled even when configured", async ({ page }) => {
  const requests = await localOnly(page, true); await ready(page);
  await page.getByRole("button", { name: "样式复刻", exact: true }).click();
  await page.locator('input[accept=".html,.htm,.txt,.json,.opslion-template.json"]').setInputFiles({ name: "new-history.html", mimeType: "text/html", buffer: Buffer.from('<section style="padding:22px;background:#faf0e9"><h1>旧活动</h1><p>旧报名说明</p><img src="https://example.com/old.png"><p>旧末段</p></section>') });
  await page.getByRole("button", { name: "分析结构和替换位", exact: true }).click();
  await page.locator(".slot-role-select").selectOption("content_image");
  await expect(page.locator(".preview-content")).toContainText("旧活动");
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  await page.getByLabel("交稿文件", { exact: true }).setInputFiles({ name: "交稿.zip", mimeType: "application/zip", buffer: await materialZip() });
  await expect(page.locator(".submission-file")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "一键排版", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("document", { name: "复刻稿件编辑画布", exact: true })).toContainText("已审正文");
  const mode = page.getByRole("group", { name: "画布模式", exact: true });
  await mode.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".preview-content")).toContainText("无需变动的末段");
  await expect(page.locator(".preview-content [contenteditable]")).toHaveCount(0);
  await mode.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("document", { name: "复刻稿件编辑画布", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 Bridge 数据包", exact: true }).click();
  const packet = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
  expect(packet.html).toContain("已审正文"); expect(packet.html).not.toContain("旧报名说明"); expect(packet.html).toContain("rgb(250, 240, 233)"); expect(packet.html).toContain("register"); expect(requests).toEqual([]);
});

test("automatic checks identify missing material and allow export as soon as it is supplied", async ({ page }) => {
  const requests = await localOnly(page); await ready(page);
  await page.getByRole("button", { name: "模板库", exact: true }).click();
  await importTestTemplates(page);
  await page.getByRole("button", { name: "套用到当前文章", exact: true }).click();
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  const source = await JSZip.loadAsync(await materialZip()); source.remove("图/现场.png");
  await page.getByLabel("交稿文件", { exact: true }).setInputFiles({ name: "主稿.zip", mimeType: "application/zip", buffer: await source.generateAsync({ type: "nodebuffer" }) });
  await expect(page.locator(".submission-file")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button", { name: "一键排版", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".workflow-hint")).toContainText("自动排版还需处理");
  await expect(page.locator(".workflow-checks summary")).toHaveAttribute("data-state", "error");
  await page.locator(".workflow-checks summary").click();
  await expect(page.locator(".workflow-check-results")).toContainText("图/现场.png");
  await page.locator(".workflow-checks summary").press("Escape");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Bridge 数据包/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^下载独立 HTML/ })).toBeEnabled();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.getByRole("button", { name: "交稿与素材", exact: true }).click();
  const images = new JSZip(); images.file("图/现场.png", Buffer.from(pixel, "base64"));
  await page.getByLabel("交稿文件", { exact: true }).setInputFiles({ name: "补图.zip", mimeType: "application/zip", buffer: await images.generateAsync({ type: "nodebuffer" }) });
  await expect(page.locator(".submission-file")).toHaveCount(2);
  await page.getByRole("button", { name: "关闭交稿", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".workflow-checks summary")).not.toHaveAttribute("data-state", "error");
  await expect(page.locator(".workflow-hint")).toContainText("自动排版已完成");
  await expect(page.locator(".preview-content img")).toHaveCount(1);
  await expect(page.locator(".preview-content")).toContainText("无需变动的末段");
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载 Bridge 数据包", exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
});

test("local references keep ambiguity visible and deletion cancels missing image without resurrection", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const api = window.opTest, s = api.submission, w = api.workflow;
    const file = new File(["通知\n\n普通正文见图1仍需发表\n\n【图1】\n\n【图片：qr.png】"], "主稿.txt");
    let state = await s.ingestFiles(s.emptySubmission(), [file]); state.main_document_ids = [state.documents[0].id];
    state.assets = ["a", "b"].map((id) => ({ id, storage_ref: `https://example.com/${id}.png`, media_type: "image/png", origins: [{ file_id: id, relative_path: `${id}/图1.png` }], aliases: [] }));
    state = w.planLocalSubmission(state);
    const missing = s.unresolvedImages(state), candidateCount = Object.values(state.bindings).filter((b) => b.status === "pending").map((b) => b.status === "pending" ? b.candidate_asset_ids.length : 0);
    let project = s.commitSubmission(api.createDefaultProject(), state); const previous = project;
    const article = { ...project.layout!.article, nodes: [...project.layout!.article.nodes.filter((n) => n.id !== state.draft!.nodes.at(-1)!.id), { id: "human-added", type: "paragraph" as const, content: [{ text: "人工新增" }] }] };
    project = w.recordEdit(project, { ...project, layout: { ...project.layout!, article }, submission: s.syncDraftEdits(state, article) });
    const rerun = w.localCandidate(project, []);
    return { missing: missing.length, candidateCount, original: api.renderProject(previous), after: api.renderProject(rerun), pending: s.unresolvedImages(rerun.submission!).length, edits: rerun.workflow!.edits, cancellations: rerun.submission!.decisions };
  });
  expect(result.missing).toBe(2); expect(result.candidateCount).toContain(2); expect(result.original).toContain("普通正文见图1仍需发表"); expect(result.after).toContain("人工新增"); expect(result.after).not.toContain("qr.png"); expect(result.pending).toBe(1); expect(result.cancellations.some((d) => d.resolution.includes("取消"))).toBe(true); expect(result.edits[0].deleted).toHaveLength(1);
});

test("layout decisions reject content, forged approvals, human overrides and stale versions", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, e = api.layoutEngine, w = api.workflow;
    const p = api.createDefaultProject(); p.layout = e.createLayoutState(e.testArticle, e.testTemplates[1]);
    const t = p.layout.template; t.components["body-other"] = structuredClone(t.components.body); t.mapping.paragraph!.allowedVariants = ["body-other"];
    const request = w.layoutRequest(p); const plan = { schema: "opslion/layout-decisions/v1", id: "r1", baseRevision: request.baseRevision, decisions: [{ kind: "component_variant", nodeId: "intro", componentId: "body-other", requirementIds: [] }], unresolved: [] };
    const changed = w.applyLayoutDecisions(p, plan); const outcomes: boolean[] = [];
    for (const candidate of [{ ...plan, approved: true }, { ...plan, decisions: [{ ...plan.decisions[0], origin: "human" }] }, { ...plan, decisions: [{ ...plan.decisions[0], content: [{ text: "改写" }] }] }, { ...plan, decisions: [{ ...plan.decisions[0], nodeId: "unknown" }] }]) { try { w.applyLayoutDecisions(p, candidate); outcomes.push(false); } catch { outcomes.push(true); } }
    const locked = { ...p, layout: { ...p.layout, nodeVariants: { intro: "body" } } }; try { w.applyLayoutDecisions(locked, { ...plan, baseRevision: w.projectRevision(locked) }); outcomes.push(false); } catch { outcomes.push(true); }
    const altered = { ...p, layout: { ...p.layout!, article: { ...p.layout!.article, nodes: p.layout!.article.nodes.map((n) => n.id === "intro" ? { ...n, type: "paragraph" as const, content: [{ href: "https://example.com/new", content: [{ text: "新链接" }] }] } : n) } } };
    try { w.applyLayoutDecisions(altered, plan); outcomes.push(false); } catch { outcomes.push(true); }
    return { outcomes, preserved: JSON.stringify(changed.layout!.article) === JSON.stringify(p.layout.article), variant: changed.layout!.nodeVariants?.intro, ready: w.contentBlockers(changed).length === 0, revisionChanged: w.projectRevision(altered) !== request.baseRevision };
  });
  expect(result.outcomes.every(Boolean)).toBe(true); expect(result.variant).toBe("body-other"); expect(result.preserved).toBe(true); expect(result.ready).toBe(true); expect(result.revisionChanged).toBe(true);
});

test("two tabs refuse to overwrite a newer saved manuscript and preserve the losing edit as a copy", async ({ page, context }) => {
  await ready(page, true);
  const id = await page.evaluate(async () => { const p = window.opTest.createDefaultProject(); await window.opTest.saveProject(p); return p.id; });
  const other = await context.newPage(); await ready(other, true); await other.evaluate(() => window.opTest.loadProjects());
  await page.evaluate(async (id) => { const p = (await window.opTest.loadProjects()).find((p) => p.id === id)!; await window.opTest.saveProject({ ...p, name: "先保存的新版本" }); }, id);
  const result = await other.evaluate(async (id) => { const api = window.opTest; const p = (await api.loadProjects()).find((p) => p.id === id)!; let error = ""; try { await api.saveProject({ ...p, name: "过期写入" }); } catch (e) { error = String(e); } await api.saveProject({ ...p, id: "conflict-copy", name: "冲突编辑副本" }); const all = await api.loadProjects(); return { error, original: all.find((p) => p.id === id)!.name, copy: all.find((p) => p.id === "conflict-copy")!.name }; }, id);
  expect(result.error).toContain("其他标签页"); expect(result.original).toBe("先保存的新版本"); expect(result.copy).toBe("冲突编辑副本");
});

test("browser and gateway share the same legal and illegal decision fixtures", async ({ page }) => {
  await ready(page, true);
  const cases = JSON.parse(await readFile("tests/fixtures/layout-decisions.json", "utf8")) as Array<{ name: string; valid: boolean; decisions: unknown[]; extra?: object }>;
  const results = await page.evaluate((cases) => {
    const api = window.opTest, e = api.layoutEngine, w = api.workflow;
    const project = api.createDefaultProject();
    const article = e.parsedArticleSchema.parse({ schema: "opslion.article/v1", id: project.id, nodes: [{ id: "t", type: "article_title", content: [{ text: "合成稿" }] }, { id: "p", type: "paragraph", content: [{ text: "已审文字" }] }, ...["i1", "i2"].map((id) => ({ id, type: "image", src: `https://example.com/${id}.png`, alt: "图" }))] });
    project.layout = e.createLayoutState(article, e.testTemplates[1]); const template = project.layout.template;
    template.components["body-other"] = structuredClone(template.components.body); template.mapping.paragraph!.allowedVariants = ["body-other"];
    const plan = { schema: "opslion/layout-decisions/v1", id: "fixture", baseRevision: w.projectRevision(project), unresolved: [] };
    return cases.map((item) => { try { w.applyLayoutDecisions(project, { ...plan, decisions: item.decisions, ...item.extra }); return true; } catch { return false; } });
  }, cases);
  expect(results).toEqual(cases.map((c) => c.valid));
});

test("AI image groups survive rebinding and manual image groups cannot be overwritten", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission, e = api.layoutEngine, w = api.workflow;
    const input = s.emptySubmission(); input.assets = ["a1", "a2", "a3"].map((id) => ({ id, storage_ref: `https://example.com/${id}.png`, origins: [], aliases: [], media_type: "image/png" }));
    const assembled = s.assembleSubmission(input, { schema: "opslion/submission-plan/v1", mode: "new", article: { nodes: [{ id: "t", type: "article_title", content: [{ text: "图片测试" }], source_ids: [] }, ...[1, 2].map((n) => ({ id: `i${n}`, type: "image_ref", request_id: `r${n}`, source_ids: [] }))] }, image_requests: [1, 2].map((n) => ({ id: `r${n}`, purpose: `图${n}`, selector: { kind: "asset", asset_id: `a${n}` }, source_ids: [] })), pending: [] });
    let p = api.createDefaultProject(); p.layout = e.createLayoutState(s.projectDraft(assembled), e.testTemplates[1]); p = s.commitSubmission(p, assembled);
    const plan = { schema: "opslion/layout-decisions/v1", id: "pair", baseRevision: w.projectRevision(p), decisions: [{ kind: "image_group", nodeIds: ["i1", "i2"] }], unresolved: [] };
    const grouped = w.applyLayoutDecisions(p, plan), rebound = s.commitSubmission(grouped, s.bindAsset(grouped.submission!, "r1", "a3"));
    const groupIds = rebound.layout!.article.nodes.filter((n) => n.type === "image").map((n) => n.group);
    const manual = { ...p, layout: { ...p.layout!, article: { ...p.layout!.article, nodes: p.layout!.article.nodes.map((n) => n.type === "image" ? { ...n, group: "human-pair" } : n) } } };
    let rejected = false; try { w.applyLayoutDecisions(manual, { ...plan, baseRevision: w.projectRevision(manual) }); } catch { rejected = true; }
    return { groupIds, html: api.renderProject(rebound), rejected };
  });
  expect(result.groupIds[0]).toBeTruthy(); expect(new Set(result.groupIds).size).toBe(1); expect(result.html).toContain("a3.png"); expect(result.rejected).toBe(true);
});

test("ambiguous main documents and mismatched native image positions stay explicit", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const api = window.opTest, s = api.submission, w = api.workflow, e = api.layoutEngine;
    const state = await s.ingestFiles(s.emptySubmission(), [new File(["主稿甲"], "甲.txt"), new File(["主稿乙"], "乙.txt")]);
    let message = ""; try { w.planLocalSubmission(state); } catch (error) { message = String(error); }
    const template = api.analyzeTemplateHtml('<section><h1>旧标题</h1><img src="https://example.com/old.png"><p>旧正文</p></section>', "顺序模板"); template.slots.filter((s) => s.kind === "image").forEach((s) => { s.role = "content_image"; });
    const article = e.parsedArticleSchema.parse({ schema: "opslion.article/v1", id: "a", nodes: [{ id: "t", type: "article_title", content: [{ text: "新标题" }] }, { id: "p", type: "paragraph", content: [{ text: "必须在配图之前" }] }, { id: "i", type: "image", src: "https://example.com/new.png", alt: "图" }] });
    const filled = api.localFill.fillArticleTemplate(article, template);
    return { message, main: state.main_document_ids, unplaced: filled.state.unplacedContent, blockers: api.localFill.templateContentBlockers(filled.state) };
  });
  expect(result.message).toContain("选择一份主稿"); expect(result.main).toEqual([]); expect(result.unplaced?.some((n) => n.id === "p")).toBe(true); expect(result.blockers.join()).toContain("必须在配图之前");
});

test("Word comments and revised instructions stay pending until a human resolves them", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const api = window.opTest, s = api.submission, w = api.workflow;
    let state = await s.ingestFiles(s.emptySubmission(), [new File(["活动稿\n\n已经审定的日期"], "稿件.txt")]); state.main_document_ids = [state.documents[0].id];
    state.documents[0].annotations.push({ id: "comment-1", text: "请核对日期", source_ids: [state.documents[0].blocks[1].id] });
    state.user_instructions = "日期尚待确认"; state = w.planLocalSubmission(state);
    const initial = state.pending.length; state.decisions = state.pending.map((p) => ({ id: p.id, resolution: "人工已处理" })); state.pending = [];
    state = w.planLocalSubmission(state); const resolved = state.pending.length;
    state.user_instructions = "版式：两图并排"; state = w.planLocalSubmission(state);
    return { initial, resolved, changed: state.pending, content: s.projectDraft(state).nodes };
  });
  expect(result.initial).toBe(2); expect(result.resolved).toBe(0); expect(result.changed).toHaveLength(1); expect(result.changed[0].kind).toBe("layout_preference"); expect(JSON.stringify(result.content)).toContain("已经审定的日期");
});

test("deleting a native module cancels its missing asset while the original snapshot remains recoverable", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest, s = api.submission, w = api.workflow; const p = api.createDefaultProject(); p.mode = "clone";
    p.cloneTemplate = api.analyzeTemplateHtml('<section><section class="tn-comp-top-level"><h1>标题</h1></section><section class="tn-comp-top-level"><img src="https://example.com/old.png"></section></section>', "原生模板");
    p.cloneTemplate.slots.filter((slot) => slot.kind === "image").forEach((slot) => { slot.role = "content_image"; });
    const base = s.captureBaseline(s.emptySubmission("update"), p); const imageId = base.base_article!.nodes.find((n) => n.type === "image")!.id;
    const submission = s.assembleSubmission(base, { schema: "opslion/submission-plan/v1", mode: "update", base_article_id: p.id, changes: [{ op: "set_image", target_node_id: imageId, request_id: "missing" }], image_requests: [{ id: "missing", purpose: "缺图", selector: { kind: "file", relative_path: "missing.png" }, source_ids: [] }], pending: [] });
    const before = s.commitSubmission(p, submission), template = before.cloneTemplate!;
    const doc = new DOMParser().parseFromString(template.analyzedHtml, "text/html"); const owner = doc.querySelector("img")!.closest("[data-layout-module]")!.getAttribute("data-layout-module");
    const deleted = { ...template, modules: template.modules.map((m) => m.id === owner ? { ...m, included: false } : m) };
    const after = w.recordEdit(before, { ...before, cloneTemplate: deleted, submission: s.syncNativeEdits(submission, template, deleted) });
    const rerun = w.localCandidate(after, []);
    return { before: s.submissionBlockers(before.submission!), after: s.submissionBlockers(rerun.submission!), html: api.renderProject(rerun), log: rerun.workflow!.edits[0], restored: s.submissionBlockers(before.submission!) };
  });
  expect(result.before).toHaveLength(1); expect(result.after).toEqual([]); expect(result.html).not.toContain("<img"); expect(result.log.deleted.length).toBeGreaterThan(0); expect(result.restored).toEqual(result.before);
});

for (const outcome of ["enhanced", "malformed", "cancelled", "stale"] as const) test(`optional AI ${outcome} preserves a compilable local draft`, async ({ page }) => {
  await mockBridge(page); let calls = 0, release: (() => void) | undefined;
  await page.route("**/local-api/agent/plan", async (route) => {
    calls++; const request = route.request().postDataJSON();
    if (outcome === "cancelled" || outcome === "stale") await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { ok: true, requests: 1, plan: outcome === "malformed" ? { approved: true } : { schema: "opslion/layout-decisions/v1", id: "r", baseRevision: request.baseRevision, decisions: [], unresolved: [] } } }).catch(() => {});
  });
  await ready(page); await page.getByRole("button", { name: "模板库", exact: true }).click(); await importTestTemplates(page); await page.getByRole("button", { name: "套用到当前文章", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "一键排版", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect.poll(() => calls).toBe(1);
  if (outcome === "cancelled" || outcome === "stale") {
    if (outcome === "cancelled") await page.getByLabel("排版执行方式").selectOption("local");
    else await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("等待时人工修改");
    release!();
  }
  await expect.poll(async () => { const p = await page.evaluate(() => window.opTest.loadActiveProject()); return p?.workflow?.run?.status; }).toBe(outcome === "malformed" ? "fallback" : outcome);
  await saved(page);
  const state = await page.evaluate(async () => { const p = (await window.opTest.loadActiveProject())!; return { html: window.opTest.renderProject(p), reviews: p.workflow!.reviews, visual: p.workflow!.run!.visualReview }; });
  expect(state.html.length).toBeGreaterThan(100); if (outcome === "stale") expect(state.html).toContain("等待时人工修改"); expect(state.reviews).toBeUndefined(); expect(state.visual).toBe("not-run");
  if (outcome === "enhanced") { await page.getByRole("button", { name: "一键排版", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(calls).toBe(1); }
});
