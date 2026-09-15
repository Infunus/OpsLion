import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLogin } from "../../scripts/collector-auth.mjs";
import { presentVerification } from "../../scripts/collector-verification.mjs";

test("登录验证码保留原标签，交接只显示页面并复用会话", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "opslion-handoff-test-"));
  const profile = path.join(runtime, "profile");
  const context = await chromium.launchPersistentContext(profile, { headless: true, args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"] });
  try {
    let navigations = 0;
    await context.route("https://weread.qq.com/**", (route) => { navigations++; return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<title>登录测试</title><div id="tcaptcha_wrapper_transform_dy" style="width:220px;height:150px">请完成人机验证</div>' }); });
    const page = await context.newPage();
    await page.goto("https://weread.qq.com/");
    await context.addCookies([{ name: "wr_vid", value: "123", url: "https://weread.qq.com/" }]);
    const config = { chromePort: Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]), chromeProfileDir: profile };
    const settings = { runtime, source: path.resolve("integrations/weread-mp-fetcher") };
    const result = await runLogin(settings, config, { job_id: "test", cancel_file: path.join(runtime, "test.cancel") }, () => {});
    expect(result).toMatchObject({ state: "paused", code: "verification" });
    expect(page.isClosed()).toBe(false);
    expect(fs.existsSync(path.join(runtime, "login-qr.png"))).toBe(false);
    const before = JSON.parse(fs.readFileSync(path.join(runtime, "verification.json"), "utf8"));
    await presentVerification(settings, config);
    const after = JSON.parse(fs.readFileSync(path.join(runtime, "verification.json"), "utf8"));
    expect(after).toMatchObject({ target_id: before.target_id, state: "opened" });
    expect(navigations).toBe(1);
    await expect(page.getByText("请完成人机验证")).toBeVisible();
    expect((await context.cookies()).find((cookie) => cookie.name === "wr_vid")?.value).toBe("123");
    await page.close();
    await presentVerification(settings, config);
    const restored = context.pages().find((tab) => tab.url() === "https://weread.qq.com/");
    expect(restored).toBeDefined();
    await expect(restored!.getByText("请完成人机验证")).toBeVisible();
    expect(navigations).toBe(2);
  } finally {
    await context.close();
    expect(path.dirname(path.resolve(runtime))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(runtime)).toMatch(/^opslion-handoff-test-/);
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
