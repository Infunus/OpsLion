import { test, expect } from "@playwright/test";
import { config, mockBridge, saved } from "./helpers";

for (const configured of [false, true]) {
  test(`header icons stay centered and mode switches keep controls anchored (model configured: ${configured})`, async ({ page }, testInfo) => {
    await mockBridge(page);
    await page.route("**/local-api/agent/config", (route) => route.fulfill({ json: { config: { ...config, configured } } }));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("http://127.0.0.1:3108");
    await expect(page.locator(".studio-shell")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("html")).toHaveAttribute("data-appearance-ready", "true");
    if (configured) await expect(page.locator(".agent-status-button")).toHaveClass(/configured/);

    const positions = () => page.locator(".mode-nav, .header-tools > button, .header-actions > .header-projects").evaluateAll((elements) => elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
    for (const width of [1440, 1024, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const before = await positions();
      for (const mode of ["周报", "样式复刻", "快速排版"]) {
        await page.getByRole("button", { name: mode, exact: true }).click();
        if (mode === "周报") await expect(page.locator(".weekly-titlebar")).toBeVisible();
        const after = await positions();
        expect(after).toHaveLength(before.length);
        after.forEach((position, index) => {
          expect(Math.abs(position.x - before[index].x)).toBeLessThan(1);
          expect(Math.abs(position.y - before[index].y)).toBeLessThan(1);
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
      for (const icon of ["sun", "moon"]) {
        await page.getByRole("button", { name: "深色模式", exact: true }).click();
        await expect(page.locator(`.theme-${icon}`)).toHaveCSS("opacity", "1");
        const centers = await page.locator(".header-tools").evaluate((toolbar, visibleIcon) => {
          const center = (selector: string) => {
            const { x, y, width, height } = toolbar.querySelector(selector)!.getBoundingClientRect();
            return { x: x + width / 2, y: y + height / 2 };
          };
          return { theme: center(".theme-toggle"), model: center(".agent-status-button"), themeIcon: center(`.theme-${visibleIcon}`), modelIcon: center('[data-icon="cpu"]') };
        }, icon);
        expect(Math.abs(centers.theme.y - centers.model.y)).toBeLessThan(1);
        expect(Math.abs(centers.themeIcon.y - centers.modelIcon.y)).toBeLessThan(1);
        expect(Math.abs(centers.themeIcon.x - centers.theme.x)).toBeLessThan(1);
        expect(Math.abs(centers.modelIcon.x - centers.model.x)).toBeLessThan(1);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await page.locator(".studio-header").screenshot({ path: testInfo.outputPath("header-compose.png"), animations: "disabled" });
    await page.getByRole("button", { name: "周报", exact: true }).click();
    await page.locator(".studio-header").screenshot({ path: testInfo.outputPath("header-weekly.png"), animations: "disabled" });
  });
}

test("layout controls persist and remain accessible across desktop, tablet and mobile", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockBridge(page);
  await page.addInitScript(() => {
    const key = "opslion:workspace-preferences:v1";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ dark: false, previewWidth: 390, motion: false }));
  });
  await page.goto("http://127.0.0.1:3108");
  await expect(page.locator(".studio-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/brand/opslion-favicon-v4.svg");
  expect(await page.locator(".studio-mark").evaluate(async (mark) => {
    const source = getComputedStyle(mark).maskImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (!source) return false;
    const image = new Image();
    image.src = source;
    await image.decode();
    return image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
  })).toBe(true);
  await expect(page.getByRole("button", { name: "界面动效" })).toHaveCount(0);
  const header = await page.locator(".studio-header").boundingBox();
  const navigation = await page.getByRole("navigation", { name: "工作模式" }).boundingBox();
  expect(navigation!.x).toBeGreaterThan(720);
  expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(header!.height);
  await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("九月手记");
  await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("示例标题");
  await page.getByRole("button", { name: "强调色 #36594a", exact: true }).click();
  await page.getByRole("button", { name: "紧凑", exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "紧凑", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "强调色 #36594a", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".preview-content")).toContainText("示例标题");
  await page.getByRole("button", { name: "舒展", exact: true }).click();
  await saved(page);
  await page.screenshot({ path: testInfo.outputPath("studio-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "导出到秀米", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("export.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await expect(page.locator(".studio-header")).toHaveCSS("background-color", "rgb(33, 33, 33)");
  await expect(page.locator(".preview-stage")).toHaveCSS("background-color", "rgb(24, 24, 24)");
  await page.screenshot({ path: testInfo.outputPath("studio-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.locator(".style-panel")).toBeHidden();
  await page.getByRole("button", { name: "打开版式设置", exact: true }).click();
  await expect(page.locator(".style-panel")).toBeVisible();
  await page.getByRole("button", { name: "紧凑", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".style-panel")).toBeHidden();
  await expect(page.getByRole("button", { name: "打开版式设置", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileHeader = await page.locator(".studio-header").boundingBox();
  const mobileNavigation = await page.getByRole("navigation", { name: "工作模式" }).boundingBox();
  expect(mobileNavigation!.y + mobileNavigation!.height).toBeLessThanOrEqual(mobileHeader!.height);
  await expect.poll(() => page.locator(".manuscript-title").evaluate((element) => element.clientHeight >= element.scrollHeight - 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("studio-mobile.png"), animations: "disabled" });
  await page.getByRole("button", { name: "实时预览", exact: true }).click();
  await page.getByLabel("调整画布宽度").click();
  await page.getByRole("button", { name: "640 像素", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByRole("slider", { name: "拖动调整预览宽度", exact: true })).toHaveAttribute("aria-valuenow", "640");
  await page.getByRole("button", { name: "版式设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "紧凑", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  await expect.poll(() => page.locator(".manuscript-title").evaluate((element) => element.clientHeight >= element.scrollHeight - 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.getByRole("button", { name: "样式复刻", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("template.png"), animations: "disabled" });
  await page.getByRole("button", { name: "周报", exact: true }).click();
  await expect(page.locator(".weekly-titlebar")).toBeVisible();
  await expect(page.locator(".header-export")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("weekly.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});
