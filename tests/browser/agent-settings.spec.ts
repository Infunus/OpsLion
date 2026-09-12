import { expect, test, type Page } from "@playwright/test";
import { type AgentConfig, type AgentConfigInput, type AgentProfile } from "../../app/studio/agent-client";
import catalog from "../../config/agent-providers.json" with { type: "json" };
import { config, mockBridge, ready } from "./helpers";

const claude: AgentProfile = { ...config, profile_id: "claude-connection", name: "语义识别", provider: "anthropic", protocol: "anthropic", base_url: "https://api.anthropic.com/v1", model: "synthetic-claude", api_key_saved: true, api_key_source: "windows", send_temperature: false };
const gemini: AgentProfile = { ...config, profile_id: "gemini-connection", name: "备用模型", provider: "gemini", protocol: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta", model: "synthetic-gemini", api_key_saved: true, api_key_source: "windows", send_temperature: false };

async function settingsBridge(page: Page) {
  await mockBridge(page);
  let state: AgentConfig = { ...claude, profiles: [claude, gemini], layout_ai_enabled: false, policy_generation: 1 };
  const saves: AgentConfigInput[] = [], tests: string[] = [], plans: string[] = [];
  await page.route("**/local-api/agent/config", async (route) => {
    if (route.request().method() === "POST") {
      const input: AgentConfigInput = route.request().postDataJSON();
      saves.push(input);
      const profile_id = input.profile_id || `new-${saves.length}`;
      const existing = state.profiles?.find((p) => p.profile_id === profile_id);
      const profile: AgentProfile = { ...config, ...input, profile_id, configured: Boolean(input.model),
        api_key_saved: Boolean(input.api_key || (existing?.api_key_saved && existing.base_url === input.base_url)), api_key_source: "windows" };
      // The bridge only returns public profile fields.
      delete (profile as AgentConfigInput).api_key;
      state = { ...profile, profiles: [...(state.profiles || []).filter((p) => p.profile_id !== profile_id), profile], layout_ai_enabled: state.layout_ai_enabled, policy_generation: (state.policy_generation || 0) + 1 };
    }
    await route.fulfill({ json: { config: state } });
  });
  await page.route("**/local-api/agent/test", async (route) => {
    tests.push(route.request().postData() || "");
    await route.fulfill({ json: { ok: true, latency_ms: 15, model: state.model } });
  });
  await page.route("**/local-api/agent/plan", async (route) => { plans.push(route.request().url()); await route.abort(); });
  await ready(page);
  await expect(page.locator(".agent-status-button")).toHaveAttribute("title", "模型：synthetic-claude");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  return { saves, tests, plans };
}

test("provider presets select real protocols, clear cross-provider keys, save and test explicitly", async ({ page }) => {
  const calls = await settingsBridge(page);
  for (const provider of catalog) {
    await page.getByLabel("模型服务商").selectOption(provider.id);
    await expect(page.getByLabel("API 地址", { exact: true })).toHaveValue(provider.base_url);
    await expect(page.getByLabel("API 协议", { exact: true })).toHaveValue(provider.protocol);
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("");
  }
  expect(calls.saves).toHaveLength(0);
  expect(calls.tests).toHaveLength(0);
  await page.getByLabel("模型服务商").selectOption("anthropic");
  await page.getByLabel("模型名称", { exact: true }).fill("synthetic-claude-new");
  await page.locator("#agent-api-key").fill("synthetic-entered-key");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "连接成功" })).toBeVisible();
  expect(calls.saves[0]).toMatchObject({ profile_id: "", provider: "anthropic", protocol: "anthropic", api_key: "synthetic-entered-key" });
  expect(calls.tests).toEqual(["{}"]);
  expect(calls.plans).toHaveLength(0);
  await expect(page.locator("#agent-api-key")).toHaveValue("");
  await expect(page.getByLabel("已保存的连接").locator("option")).toHaveCount(4);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("synthetic-entered-key");
});

test("saved connections switch with their own credentials and custom endpoints support mobile and dark mode", async ({ page }, testInfo) => {
  const calls = await settingsBridge(page);
  await page.getByLabel("已保存的连接").selectOption("gemini-connection");
  await expect(page.getByLabel("模型服务商")).toHaveValue("gemini");
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("synthetic-gemini");
  await expect(page.locator("#agent-api-key")).toHaveAttribute("placeholder", "留空保留当前连接的密钥");
  expect(calls.saves).toHaveLength(0);
  await page.getByRole("button", { name: "仅保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  expect(calls.saves[0]).toMatchObject({ profile_id: "gemini-connection", protocol: "gemini", api_key: "" });
  await page.getByLabel("API 地址", { exact: true }).fill("https://gateway.example/v1beta");
  await expect(page.locator("#agent-api-key")).toHaveAttribute("placeholder", "填写这个服务商的 API Key");
  await expect(page.getByText("地址已变化，请为新地址填写密钥。", { exact: true })).toBeVisible();
  await page.getByLabel("已保存的连接").selectOption("");
  await expect(page.getByLabel("模型服务商")).toHaveValue("custom");
  await expect(page.getByLabel("API 协议", { exact: true })).toBeVisible();
  await page.getByLabel("API 地址", { exact: true }).fill("https://gateway.example/v1");
  await page.getByLabel("API 协议", { exact: true }).selectOption("openai-responses");
  await page.getByLabel("模型名称", { exact: true }).fill("team/any-new-model");
  await page.getByLabel("最大输出 tokens", { exact: true }).fill("16384");
  await page.getByLabel("密钥环境变量（可选）", { exact: true }).fill("TEAM_MODEL_API_KEY");
  await page.getByRole("button", { name: "仅保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  expect(calls.saves[1]).toMatchObject({ profile_id: "", protocol: "openai-responses", model: "team/any-new-model", max_output_tokens: 16384, api_key_env: "TEAM_MODEL_API_KEY" });
  await expect(page.getByRole("button", { name: "仅保存", exact: true })).toBeEnabled();
  await page.locator(".agent-settings-body").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath("model-settings-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("team/any-new-model");
  expect(await page.locator(".agent-modal").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("model-settings-mobile.png"), animations: "disabled" });
  expect(calls.tests).toHaveLength(0);
  expect(calls.plans).toHaveLength(0);
});

test("connection failure preserves saved settings and is shown without claiming success", async ({ page }) => {
  const calls = await settingsBridge(page);
  await page.route("**/local-api/agent/test", (route) => route.fulfill({ status: 400, json: { message: "模型接口返回 HTTP 401：请检查当前连接的 API Key" } }));
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(page.locator(".agent-test-result.error")).toContainText("HTTP 401");
  await expect(page.getByRole("button", { name: "保存并测试", exact: true })).toBeEnabled();
  expect(calls.saves).toHaveLength(1);
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue("synthetic-claude");
  await expect(page.locator("#agent-api-key")).toHaveValue("");
});
