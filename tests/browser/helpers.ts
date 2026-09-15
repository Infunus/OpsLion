import { expect, type Page } from "@playwright/test";
import { testTemplates } from "./layout-fixtures";
export const harness = "/tests/browser/harness.html";
// Existing model tests represent an explicit, previously saved AI opt-in.
export const config = { base_url: "http://model.invalid/v1", model: "test-model", temperature: 0.1, configured: true, api_key_saved: false, api_key_source: "none", layout_ai_enabled: true, policy_generation: 1 };
export async function mockBridge(page: Page) {
  await page.route("**/local-api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/weekly/template-settings")) return route.fulfill({ json: { settings: { email: "weekly@example.com", contactPerson: "示例联系人", organization: "示例组织" } } });
    if (path.endsWith("/collector/status")) return route.fulfill({ json: { protocol: "opslion-collector/v1", prepared: true, module_available: true, node_available: true, browser_available: true, session: { state: "unknown", message: "等待登录" }, accounts: [], has_index: false, job: null, exports: [], quota: { used: 0, max: 40, runs: 0, max_runs: 2 } } });
    if (path.endsWith("/status") && !path.endsWith("/refresh/status")) return route.fulfill({ json: { protocol: "opslion-rss/v1", available: false, feeds: [], totals: {} } });
    if (path.endsWith("/refresh/status")) return route.fulfill({ json: { running: false, return_code: null } });
    const json = path.endsWith("/agent/config") ? { config } : path.endsWith("/agent/policy") ? { config: { ...config, layout_ai_enabled: route.request().postDataJSON().enabled, policy_generation: 2 } } : {};
    await route.fulfill({ json });
  });
}
export async function ready(page: Page, bare = false) {
  await page.goto(harness + (bare ? "?bare" : ""));
  await page.waitForFunction(() => Boolean(window.opTest));
  if (!bare) await expect(page.locator(".studio-shell")).toHaveAttribute("aria-busy", "false");
}
export async function saved(page: Page) { await expect(page.locator(".save-state")).toHaveText("已保存到本机"); }

export async function importTestTemplates(page: Page) {
  for (const template of testTemplates) {
    await page.getByLabel("导入文章模板包文件").setInputFiles({ name: "test-template.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)) });
    await expect(page.getByRole("button", { name: `选择${template.name}`, exact: true })).toBeVisible();
  }
}
