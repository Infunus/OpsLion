import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const previewHtml = `<article class="paper">
  <section class="tn-comp-top-level">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="100%">
      <rect width="320" height="240" fill="#e9ddfa"/>
      <svg viewBox="0 0 320 240" height="240">
        <foreignObject width="320" height="240"><section xmlns="http://www.w3.org/1999/xhtml"><p><strong>合成 SVG 标题</strong></p><p>点击后展开的测试正文。</p></section></foreignObject>
        <animate attributeName="height" begin="click" from="120" to="240" dur="0.4s" fill="freeze"/>
      </svg>
      <animate attributeName="opacity" begin="click" values="1;0.6;1" dur="0.4s"/>
    </svg>
  </section>
  <section class="tn-comp-top-level"><p>独立测试板块</p></section>
</article>`;

interface PopupHarness {
  storageReads: number;
  storage: Record<string, unknown>;
  storageWrites: Record<string, unknown>[];
  tabQueries: { active?: boolean; currentWindow?: boolean }[];
  createdTabs: { url: string }[];
  scriptCalls: { tabId: number; allFrames: boolean; functionName: string }[];
}

declare global { interface Window { svgPopupHarness: PopupHarness } }

test("popup loads its capture module and preserves SVG through capture, download and send", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const sourceUrl = "https://xiumi.us/studio/v5#/paper/edit/123456";
  await page.addInitScript(({ html, source }) => {
    const state: PopupHarness = {
      storageReads: 0, storage: {}, storageWrites: [], tabQueries: [], createdTabs: [], scriptCalls: [],
    };
    window.svgPopupHarness = state;
    const root = new DOMParser().parseFromString(html, "text/html").querySelector("article")!;
    const stats = {
      elements: root.querySelectorAll("*").length + 1,
      images: root.querySelectorAll("img").length,
      links: root.querySelectorAll("a[href]").length,
      blocks: root.querySelectorAll(".tn-comp-top-level").length,
      svgs: root.querySelectorAll("svg").length,
      animations: root.querySelectorAll("animate").length,
      textLength: (root.textContent || "").trim().length,
    };
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: {
        storage: { local: {
          get: async (keys: string[]) => {
            state.storageReads += 1;
            return Object.fromEntries(keys.filter((key) => key in state.storage).map((key) => [key, state.storage[key]]));
          },
          set: async (value: Record<string, unknown>) => {
            const saved = structuredClone(value);
            state.storageWrites.push(saved);
            Object.assign(state.storage, saved);
          },
        } },
        tabs: {
          query: async (options: { active?: boolean; currentWindow?: boolean }) => {
            state.tabQueries.push(options);
            return [{ id: 41, url: source, title: "合成 SVG 编辑页" }];
          },
          create: async (options: { url: string }) => {
            state.createdTabs.push(options);
            return { id: 42, ...options };
          },
        },
        scripting: {
          executeScript: async (request: { target: { tabId: number; allFrames?: boolean }; func: { name: string } }) => {
            state.scriptCalls.push({ tabId: request.target.tabId, allFrames: Boolean(request.target.allFrames), functionName: request.func.name });
            if (!request.target.allFrames) return [{ frameId: 0, result: { needsPreview: true } }];
            return [
              { frameId: 0, result: { title: "未展开的编辑画布", sourceType: "xiumi", html: "<p>编辑草稿</p>", score: 10, renderedPreview: false } },
              { frameId: 2, result: { title: "SVG 合成预览", sourceType: "xiumi", renderedPreview: true, html, stats, score: 1000000 } },
            ];
          },
        },
      },
    });
  }, { html: previewHtml, source: sourceUrl });

  const sentTemplates: Record<string, unknown>[] = [];
  const bridgeCalls: { method: string; path: string }[] = [];
  // Route the entire bridge origin so the test cannot reach a running backend.
  await page.route("http://127.0.0.1:4319/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    bridgeCalls.push({ method: request.method(), path });
    const headers = {
      "Access-Control-Allow-Origin": request.headers().origin || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() !== "POST" || path !== "/templates/import") return route.fulfill({ status: 404, headers, json: { message: "Unexpected bridge request" } });
    sentTemplates.push(request.postDataJSON());
    await route.fulfill({ headers, json: { ok: true, template: { id: "svg popup/1" } } });
  });

  const captureModuleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/integrations/xiumi-bridge/capture-page.js");
  await page.goto("/integrations/xiumi-bridge/popup.html");
  expect((await captureModuleResponse).ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => window.svgPopupHarness.storageReads)).toBe(1);
  await expect(page.locator('script[src="popup.js"]')).toHaveAttribute("type", "module");
  await expect(page.getByRole("button", { name: "发送到 OpsLion", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下载模板包", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "抓取当前页面排版", exact: true }).click();
  await expect(page.locator("#captureStatus")).toContainText("已抓取完整 SVG 预览");
  await expect(page.locator("#captureMeta")).toContainText("2 个 SVG · 2 个动画");
  await expect(page.locator("#captureMeta")).toContainText("2 个顶层板块");
  const captureState = await page.evaluate(() => window.svgPopupHarness);
  expect(captureState.tabQueries).toEqual([{ active: true, currentWindow: true }]);
  expect(captureState.scriptCalls).toHaveLength(2);
  expect(captureState.scriptCalls[0]).toMatchObject({ tabId: 41, allFrames: false });
  expect(captureState.scriptCalls[1]).toEqual({ tabId: 41, allFrames: true, functionName: "capturePage" });
  expect(captureState.storageWrites).toHaveLength(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载模板包", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("SVG 合成预览.opslion-template.json");
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("模板包下载没有生成文件");
  const downloadedTemplate = JSON.parse(await readFile(downloadPath, "utf8"));
  expect(downloadedTemplate).toMatchObject({
    schema: "opslion-template/v2", title: "SVG 合成预览", sourceType: "xiumi", sourceUrl,
    renderedPreview: true, html: previewHtml, stats: { svgs: 2, animations: 2, blocks: 2 },
  });
  expect(new Date(downloadedTemplate.capturedAt).toISOString()).toBe(downloadedTemplate.capturedAt);
  expect(downloadedTemplate).toEqual(captureState.storage.opslionCapturedTemplate);
  const svgStructure = await page.evaluate((html: string) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return {
      viewBox: doc.querySelector("svg")?.getAttribute("viewBox"),
      nestedSvgCount: doc.querySelectorAll("svg svg").length,
      title: doc.querySelector("foreignObject strong")?.textContent,
      animations: [...doc.querySelectorAll("animate")].map((node) => ({ attribute: node.getAttribute("attributeName"), begin: node.getAttribute("begin") })),
    };
  }, downloadedTemplate.html);
  expect(svgStructure).toEqual({ viewBox: "0 0 320 240", nestedSvgCount: 1, title: "合成 SVG 标题", animations: [{ attribute: "height", begin: "click" }, { attribute: "opacity", begin: "click" }] });

  await page.getByRole("button", { name: "发送到 OpsLion", exact: true }).click();
  await expect(page.locator("#captureStatus")).toHaveText("发送成功，正在打开样式复刻。");
  await expect.poll(() => page.evaluate(() => window.svgPopupHarness.createdTabs)).toEqual([
    { url: "http://127.0.0.1:3000/?templateImport=1&capture=svg%20popup%2F1" },
  ]);
  expect(sentTemplates).toEqual([downloadedTemplate]);
  expect(bridgeCalls.filter((call) => call.method !== "OPTIONS")).toEqual([{ method: "POST", path: "/templates/import" }]);
  expect(pageErrors).toEqual([]);
});
