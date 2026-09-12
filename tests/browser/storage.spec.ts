import { test, expect } from "@playwright/test";
import { ready, mockBridge, saved } from "./helpers";
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("migration tolerates bad records and retains the untouched legacy backup", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const api = window.opTest; const project = api.createDefaultProject();
    const raw = JSON.stringify([null, { id: "broken" }, project]);
    localStorage.setItem("wechat-agent-studio:projects:v1", raw);
    localStorage.setItem("wechat-agent-studio:active:v1", project.id);
    localStorage.setItem("wechat-agent-studio:templates:v1", "{bad json");
    const projects = await api.loadProjects(); const active = await api.loadActiveProject(projects);
    await api.removeProject(project.id);
    return { count: projects.length, active: active?.id === project.id, retained: localStorage.getItem("wechat-agent-studio:projects:v1") === raw,
      afterDelete: (await api.loadProjects()).length, notices: api.storageNotices().length, backup: await api.recoveryBackup() };
  });
  expect(result.count).toBe(1); expect(result.active).toBe(true); expect(result.retained).toBe(true); expect(result.afterDelete).toBe(0); expect(result.notices).toBeGreaterThan(0);
  expect(result.backup.legacy["wechat-agent-studio:templates:v1"]).toBe("{bad json");
  await page.reload();
  expect(await page.evaluate(async () => (await window.opTest.loadProjects()).length)).toBe(0);
});
test("images live in deduplicated blobs and queued writes preserve the latest edit", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async (pixel) => {
    const api = window.opTest; const project = api.createDefaultProject(); project.content.sections[0].imageUrl = pixel;
    const second = { ...project, id: "second" };
    await Promise.all([api.saveProject(project), api.saveProject(second), api.saveProject({ ...project, name: "最后一次编辑" })]);
    const loaded = await api.loadProjects(); const backup = await api.recoveryBackup();
    return { count: loaded.length, name: loaded.find((p) => p.id === project.id)?.name, image: loaded[0].content.sections[0].imageUrl,
      blobs: (backup.stores.assets as unknown[]).length, inlineImages: JSON.stringify(backup.stores.projects).includes("data:image"), legacy: localStorage.getItem("wechat-agent-studio:projects:v1") };
  }, pixel);
  expect(result).toEqual({ count: 2, name: "最后一次编辑", image: pixel, blobs: 1, inlineImages: false, legacy: null });
});
test("disabled localStorage does not prevent IndexedDB editing and reload", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } }); });
  await mockBridge(page); await ready(page);
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("禁用旧存储仍能保存"); await saved(page);
  await page.reload(); await expect(page.getByRole("textbox", { name: "文章标题", exact: true })).toHaveValue("禁用旧存储仍能保存");
});
test("blocked IndexedDB offers editable recovery state without claiming a save", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("blocked", "SecurityError"); } }); });
  await mockBridge(page); await ready(page);
  await expect(page.getByRole("button", { name: "备份当前项目", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("内存编辑");
  await expect(page.locator(".save-state")).toHaveText("未保存，请导出备份");
});

test("failed writes are atomic and shared images remain until the last reference is removed", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async (pixel) => {
    const api = window.opTest; const project = api.createDefaultProject(); project.content.sections[0].imageUrl = pixel;
    await api.saveProject(project); await api.saveProject({ ...project, id: "shared-image" });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { if (this.name === "projects") throw new DOMException("quota", "QuotaExceededError"); return put.call(this, value, key); };
    let rejected = false;
    try { await api.saveProject({ ...project, name: "不能覆盖" }); } catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = put; }
    const original = (await api.loadProjects()).find((item) => item.id === project.id)?.name;
    await api.removeProject(project.id);
    const afterOne = ((await api.recoveryBackup()).stores.assets as unknown[]).length;
    const survivorImage = (await api.loadProjects())[0].content.sections[0].imageUrl;
    await api.removeProject("shared-image");
    return { rejected, original, afterOne, survivorImage, afterAll: ((await api.recoveryBackup()).stores.assets as unknown[]).length };
  }, pixel);
  expect(result).toEqual({ rejected: true, original: "未命名推文", afterOne: 1, survivorImage: pixel, afterAll: 0 });
});
