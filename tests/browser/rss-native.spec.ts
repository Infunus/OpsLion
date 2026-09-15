import { test, expect } from "@playwright/test";
import { mockBridge, ready } from "./helpers";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.setItem("opslion-weekly-source", "rss")); });

test("complete RSS opens its native interface and keeps the workbench's import flow", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/status", (route) => route.fulfill({ json: {
    protocol: "opslion-rss/v1", available: true, engine: "we-mp-rss", management_mode: "native",
    management_url: "http://127.0.0.1:8001", management_version: 0, feeds: [], totals: {},
    refresh: { running: false, return_code: null },
  } }));
  await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
  const link = page.getByRole("link", { name: "打开完整 RSS", exact: true });
  await expect(link).toHaveAttribute("href", "http://127.0.0.1:8001/");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("button", { name: "管理公众号", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入处理好的文案", exact: true })).toBeVisible();
});

test("unsafe native management URL is not exposed as a link", async ({ page }) => {
  await mockBridge(page);
  await page.route("**/local-api/status", (route) => route.fulfill({ json: {
    protocol: "opslion-rss/v1", available: true, management_mode: "native", management_url: "javascript:alert(1)",
    feeds: [], totals: {}, refresh: { running: false, return_code: null },
  } }));
  await ready(page);
  await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.getByRole("button", { name: "管理公众号", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "打开完整 RSS", exact: true })).toHaveCount(0);
});
