import { expect, type Page } from "@playwright/test";
import { testTemplates } from "./layout-fixtures";
export const harness = "/tests/browser/harness.html";
// Existing model tests represent an explicit, previously saved AI opt-in.
export const config = { base_url: "http://model.invalid/v1", model: "test-model", temperature: 0.1, configured: true, api_key_saved: false, api_key_source: "none", layout_ai_enabled: true, policy_generation: 1 };
export async function mockBridge(page: Page) {
  await page.route("**/local-api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
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
