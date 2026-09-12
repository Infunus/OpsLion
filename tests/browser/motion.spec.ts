import { test, expect } from "@playwright/test";
import { mockBridge } from "./helpers";

test.use({
  // Chromium's headless default hides the scrollbar that caused the layout jump.
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  video: { mode: "on", size: { width: 1440, height: 1000 } },
});

for (const width of [1440, 1024]) {
  test(`compose and clone keep the page width stable throughout their transition at ${width}px`, async ({ page }, testInfo) => {
    await mockBridge(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("http://127.0.0.1:3108");
    await expect(page.locator(".studio-shell")).toHaveAttribute("aria-busy", "false");
    await page.locator(".editor-panel").evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)));
    for (const mode of ["样式复刻", "快速排版", "样式复刻", "快速排版"]) {
      const frames = await page.evaluate(async (mode) => {
        const measure = () => ({
          width: document.documentElement.clientWidth,
          overflow: document.documentElement.scrollHeight - innerHeight,
          panels: [".studio-header", ".mode-nav", ".workspace-grid", ".preview-stage"].map((selector) => {
            const { x, width } = document.querySelector(selector)!.getBoundingClientRect();
            return { x, width };
          }),
        });
        const frames = [measure()];
        [...document.querySelectorAll<HTMLButtonElement>(".mode-nav button")].find((button) => button.textContent === mode)!.click();
        const until = performance.now() + 550;
        while (performance.now() < until) {
          await new Promise(requestAnimationFrame);
          frames.push(measure());
        }
        return frames;
      }, mode);
      await testInfo.attach(`${mode}-frames`, { body: JSON.stringify(frames), contentType: "application/json" });
      expect(frames.length).toBeGreaterThan(3);
      expect(Math.max(...frames.map((frame) => frame.overflow))).toBeLessThanOrEqual(0);
      expect(new Set(frames.map((frame) => frame.width)).size).toBe(1);
      for (const frame of frames) frame.panels.forEach((panel, index) => {
        expect(Math.abs(panel.x - frames[0].panels[index].x)).toBeLessThan(1);
        expect(Math.abs(panel.width - frames[0].panels[index].width)).toBeLessThan(1);
      });
    }
  });
}

test("palette and segmented choices interpolate, the inspector stays compact and reduced motion is respected", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockBridge(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.goto("http://127.0.0.1:3108");
  await expect(page.locator(".studio-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("html")).toHaveAttribute("data-appearance-ready", "true");
  const article = await page.locator(".preview-content").innerHTML();
  const transition = await page.evaluate(async () => {
    const color = () => getComputedStyle(document.querySelector(".studio-header")!).backgroundColor;
    const before = color();
    document.querySelector<HTMLButtonElement>(".theme-toggle")!.click();
    // React may commit the theme after the first two frames under concurrent tests.
    // Sample the first changed frame; a jump straight to the final color still fails.
    for (let frame = 0; frame < 30 && color() === before; frame++) await new Promise(requestAnimationFrame);
    return { before, middle: color() };
  });
  expect(transition.middle).not.toBe(transition.before);
  expect(transition.middle).not.toBe("rgb(33, 33, 33)");
  await expect(page.locator(".studio-header")).toHaveCSS("background-color", "rgb(33, 33, 33)");
  await expect(page.locator(".preview-content")).toHaveJSProperty("innerHTML", article);

  const slide = await page.getByRole("group", { name: "阅读节奏", exact: true }).evaluate(async (group) => {
    const indicator = group.querySelector<HTMLElement>(".segment-indicator")!;
    const start = indicator.getBoundingClientRect().x;
    const distance = indicator.getBoundingClientRect().width;
    group.querySelectorAll("button")[1].click();
    for (let frame = 0; frame < 30 && indicator.getBoundingClientRect().x === start; frame++) await new Promise(requestAnimationFrame);
    return { moved: indicator.getBoundingClientRect().x - start, distance };
  });
  expect(slide.moved).toBeGreaterThan(0);
  expect(slide.moved).toBeLessThan(slide.distance);
  const density = page.getByRole("button", { name: "紧凑", exact: true });
  await expect(density).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.locator(".property-segment").evaluate((group) => {
    const indicator = group.querySelector(".segment-indicator")!.getBoundingClientRect();
    const selected = group.querySelector('[aria-pressed="true"]')!.getBoundingClientRect();
    return Math.abs(indicator.x - selected.x);
  })).toBeLessThan(1);
  const spec = await page.locator(".template-spec").boundingBox();
  const footer = await page.locator(".inspector-footer").boundingBox();
  expect(footer!.y - (spec!.y + spec!.height)).toBeLessThanOrEqual(28);
  await page.screenshot({ path: testInfo.outputPath("refined-dark.png"), animations: "disabled" });

  await page.getByRole("button", { name: "舒展", exact: true }).click();
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await expect(page.locator(".studio-header")).toHaveCSS("background-color", "rgb(252, 252, 249)");
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await expect(page.locator(".studio-header")).toHaveCSS("background-color", "rgb(252, 252, 249)");
  await density.focus(); await page.keyboard.press("Space");
  await expect(density).toHaveAttribute("aria-pressed", "true");
  await expect(density).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await expect(page.locator(".studio-header")).toHaveCSS("background-color", "rgb(33, 33, 33)");
  expect(await page.locator("html").evaluate((root) => root.getAnimations().length)).toBe(0);
  await page.getByRole("button", { name: "舒展", exact: true }).click();
  expect(await page.locator(".segment-indicator").first().evaluate((indicator) => indicator.getAnimations().length)).toBe(0);
  expect(errors).toEqual([]);
});
