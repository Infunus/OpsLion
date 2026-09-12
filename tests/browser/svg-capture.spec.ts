import { test, expect } from "@playwright/test";
import { capturePage } from "../../integrations/xiumi-bridge/capture-page.js";
import { ready } from "./helpers";

// Reproduces the rendered Xiumi SVG shape without storing real article content.
const fixture = `<html><head><meta charset="utf-8"><style>
body{margin:0;font:14px Arial} article{width:390px}p{margin:0;padding:0}.label{font-weight:700}
.paint{fill:rgb(254,254,254);stroke:rgb(40,70,100);stroke-width:2px}
.gradient{stop-color:rgb(166,213,243);stop-opacity:.8}
.outline{fill:none;stroke:red}.hidden{display:none}
</style></head><body><article class="paper tn-cube-box" tn-comp-role="page">
<section class="tn-comp-top-level"><p>SVG 导出检查</p><svg width="100%" viewBox="0 0 900 183" style="display:block;max-width:none!important;pointer-events:none">
<defs><linearGradient id="paint"><stop class="gradient" offset="0"/></linearGradient><path id="shape" d="M0 0H100V100H0Z"/><path class="outline" id="outline" d="M0 0H100V100H0Z"/></defs>
<g class="hidden" display="inline"><rect width="100%" height="100%"/></g>
<svg width="100%" height="100%"><rect class="paint" width="100%" height="100%" pointer-events="visible"/>
<svg x="5%" y="26.76%" width="90%" height="46.49%"><foreignObject width="100%" height="100%" style="font-size:330.91%;text-align:center;color:#a6d5f3;pointer-events:none"><p class="label"><strong>院队示例</strong></p></foreignObject></svg>
<use href="#shape" fill="url(#paint)"/><image href="/sample.png" x="850" y="150" width="20" height="20"/>
<g opacity="0"><rect width="100%" height="100%" pointer-events="visible"/><animateTransform attributeName="transform" type="translate" values="-9999 0;-9999 0;-900 0" begin="click" dur="1s" fill="freeze" keyTimes="0;0.99;1" calcMode="discrete"/></g></svg>
<animate attributeName="opacity" begin="click" from="1" to="0" dur="0.1" fill="freeze"/>
<animate attributeName="width" begin="click + 0.1s" from="100%" to="1938.8111016991381%" dur="1" fill="freeze"/>
</svg></section></article></body></html>`;

test("Bridge captures rendered SVG without freezing geometry and OpsLion round trips it", async ({ page }, testInfo) => {
  await page.route("https://v.xiumius.cn/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  await page.goto("https://v.xiumius.cn/board/svg-fixture");
  const capture = await page.evaluate(capturePage);
  if (!capture?.html || !capture.stats) throw new Error("Rendered preview was not captured");
  expect(capture.renderedPreview).toBe(true);
  expect(capture.stats.svgs).toBe(3);
  expect(capture.stats.animations).toBe(3);
  await ready(page, true);
  const result = await page.evaluate((source) => {
    const api = window.opTest;
    const raw = new DOMParser().parseFromString(source, "text/html");
    const template = api.analyzeTemplateHtml(source, "SVG 示例");
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: template };
    const parsed = api.parseProjectFile(JSON.parse(JSON.stringify({ schema: "wechat-agent-studio/project-v1", project })));
    const html = api.wrapStandaloneHtml(api.renderProject(parsed), "SVG 示例");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector("svg")!;
    return {
      viewBox: root.getAttribute("viewBox"), width: root.getAttribute("width"),
      cssWidth: raw.querySelector("svg")!.style.width, cssHeight: raw.querySelector("svg")!.style.height,
      label: doc.querySelector("foreignObject")?.textContent?.trim(),
      svgCount: doc.querySelectorAll("svg").length, animations: doc.querySelectorAll("animate,animateTransform").length,
      target: doc.querySelector('animate[attributeName="width"]')?.getAttribute("to"),
      paint: doc.querySelector("svg > svg > rect")?.getAttribute("style"), gradient: doc.querySelector("stop")?.getAttribute("style"),
      pathFill: (doc.querySelector("defs path") as SVGElement)?.style.fill,
      outlineFill: (doc.querySelector("defs path:last-child") as SVGElement)?.style.fill,
      hiddenDisplay: (doc.querySelector('g[display="inline"]') as SVGElement)?.style.display,
      labelMargin: doc.querySelector("foreignObject p")?.getAttribute("style"),
      image: doc.querySelector("image")?.getAttribute("href"),
      ref: doc.querySelector("use")?.getAttribute("href"),
      html,
    };
  }, capture.html);
  expect(result).toMatchObject({ viewBox: "0 0 900 183", width: "100%", cssWidth: "", cssHeight: "", label: "院队示例", svgCount: 3, animations: 3, target: "1938.8111016991381%", image: "https://v.xiumius.cn/sample.png" });
  expect(result.paint).toContain("fill: rgb(254, 254, 254)");
  expect(result.paint).toContain("stroke-width: 2px");
  expect(result.gradient).toContain("stop-color: rgb(166, 213, 243)");
  expect(result.ref).toMatch(/^#opslion_svg_/);
  expect(result.pathFill).toBe("");
  expect(result.outlineFill).toBe("none");
  expect(result.hiddenDisplay).toBe("none");
  expect(result.labelMargin).toContain("margin: 0px");
  // Compare the captured SVG's initial viewBox aspect ratio in an isolated page.
  await page.setContent(result.html);
  const bounds = await page.locator("svg").first().boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height / bounds!.width).toBeCloseTo(183 / 900, 2);
  await expect(page.locator("foreignObject strong span")).toBeVisible();
  await testInfo.attach("svg-roundtrip.html", { body: result.html, contentType: "text/html" });
  await page.screenshot({ path: testInfo.outputPath("svg-roundtrip.png") });
});

test("Bridge reports unfinished editor SVG so the popup requests the rendered preview", async ({ page }) => {
  await page.route("https://xiumi.us/**", (route) => route.fulfill({ contentType: "text/html", body: fixture.replace('class="paper tn-cube-box"', 'class="tn-page-inst"').replace('from="100%" to="1938.8111016991381%"', 'class="expand-self-animation" revert-expand="{}"') }));
  await page.goto("https://xiumi.us/studio/v5");
  const capture = await page.evaluate(capturePage);
  if (!capture || !("html" in capture)) throw new Error("Editor was not captured");
  expect(capture.incompleteAnimations).toBe(true);
  expect(capture.renderedPreview).toBe(false);
  expect(capture.html).toContain('viewBox="0 0 900 183"');
});
