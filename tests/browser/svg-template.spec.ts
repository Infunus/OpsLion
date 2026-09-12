import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

const svgTemplate = `<article>
  <section class="tn-comp-top-level">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 0 240 180" preserveAspectRatio="xMidYMid meet" width="100%">
      <defs>
        <linearGradient id="paint"><stop offset="0" stop-color="#8844aa"/><stop offset="1" stop-color="#ddbbff"/></linearGradient>
        <clipPath id="crop"><rect width="220" height="160" rx="12"/></clipPath>
        <path id="shape" d="M0 0 H220 V160 H0Z"/>
      </defs>
      <g clip-path="url(#crop)"><use href="#shape" fill="url(#paint)"/><use xlink:href="#shape" xmlns:xlink="http://www.w3.org/1999/xlink" opacity="0.2"/></g>
      <text x="12" y="24"><tspan>SVG 装饰文字</tspan></text>
      <foreignObject x="10" y="35" width="200" height="120">
        <section xmlns="http://www.w3.org/1999/xhtml"><p><strong>可编辑的标题</strong></p><p>卡片正文</p></section>
      </foreignObject>
      <animate attributeName="opacity" begin="click" values="1;0;1" dur="1s"/>
    </svg>
  </section>
  <section class="tn-comp-top-level"><p>第二模块正文</p></section>
</article>`;

test("SVG geometry survives template editing while foreignObject text stays editable", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((source) => {
    const api = window.opTest;
    const state = api.analyzeTemplateHtml(source, "SVG 卡片");
    const nativeSlot = state.slots.some((slot) => slot.value.includes("SVG 装饰文字"));
    const title = state.slots.find((slot) => slot.value === "可编辑的标题");
    if (!title) throw new Error("foreignObject 标题没有识别为文本槽");
    title.value = "更新后的标题";
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: JSON.parse(JSON.stringify(state)) };
    const rendered = api.renderProject(project);
    const doc = new DOMParser().parseFromString(rendered, "text/html");
    const svg = doc.querySelector("svg")!;
    const foreignTitle = doc.querySelector("foreignObject strong span");
    const reset = api.pristineTemplateState(state);
    const standaloneSvg = api.analyzeTemplateHtml('<svg viewBox="0 0 200 100"><rect width="200" height="100"/><svg viewBox="0 0 200 100"><foreignObject width="200" height="100"><p>根 SVG 正文</p></foreignObject><animate attributeName="height" begin="click" values="100;60;100" dur="1s"/></svg></svg>', "完整 SVG");
    const standaloneDoc = new DOMParser().parseFromString(standaloneSvg.analyzedHtml, "text/html");
    return {
      nativeSlot, moduleCount: state.modules.length,
      nativeText: svg.querySelector("text tspan")?.textContent,
      nativeWrapperCount: svg.querySelectorAll("text span,tspan span").length,
      viewBox: svg.getAttribute("viewBox"), aspect: svg.getAttribute("preserveAspectRatio"),
      namespace: svg.namespaceURI, foreignNamespace: foreignTitle?.namespaceURI,
      editedTitle: foreignTitle?.textContent, animations: svg.querySelectorAll("animate").length,
      gradient: svg.querySelector("linearGradient")?.localName,
      resetTitle: reset.slots.some((slot) => slot.value === "可编辑的标题"),
      standaloneModules: standaloneSvg.modules.length,
      standaloneModuleTag: standaloneDoc.querySelector("[data-layout-module]")?.localName,
      standaloneSvgCount: standaloneDoc.querySelectorAll("svg").length,
      nestedHeightAnimation: standaloneDoc.querySelector("svg svg animate")?.getAttribute("attributeName"),
    };
  }, svgTemplate);
  expect(result).toEqual({
    nativeSlot: false, moduleCount: 2, nativeText: "SVG 装饰文字", nativeWrapperCount: 0,
    viewBox: "-10 0 240 180", aspect: "xMidYMid meet", namespace: "http://www.w3.org/2000/svg",
    foreignNamespace: "http://www.w3.org/1999/xhtml", editedTitle: "更新后的标题", animations: 1,
    gradient: "linearGradient", resetTitle: true, standaloneModules: 1, standaloneModuleTag: "svg",
    standaloneSvgCount: 2, nestedHeightAnimation: "height",
  });
});

test("duplicated SVG modules keep independent definitions and local references", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate((source) => {
    const api = window.opTest;
    const state = api.analyzeTemplateHtml(source, "SVG 模块复制");
    const duplicate = api.duplicateTemplateModule(state, state.modules[0].id);
    const inspect = (html: string) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
      const svgs = [...doc.querySelectorAll("svg")];
      const references = svgs.map((svg) => {
        const ownIds = new Set([svg, ...svg.querySelectorAll("[id]")].map((node) => node.id).filter(Boolean));
        const refs: string[] = [];
        [svg, ...svg.querySelectorAll("*")].forEach((node) => [...node.attributes].forEach((attribute) => {
          if (attribute.localName === "href" && attribute.value.startsWith("#")) refs.push(attribute.value.slice(1));
          for (const match of attribute.value.matchAll(/url\(\s*["']?#([^\s"')]+)/gi)) refs.push(match[1]);
        }));
        return { count: refs.length, local: refs.every((id) => ownIds.has(id)) };
      });
      return { svgCount: svgs.length, uniqueIds: new Set(ids).size === ids.length, references };
    };
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: duplicate };
    const html = api.renderProject(project);
    const moved = api.moveTemplateModule(duplicate, duplicate.modules[0].id, duplicate.modules[2].id);
    return {
      beforeExport: inspect(duplicate.analyzedHtml), afterExport: inspect(api.wrapStandaloneHtml(html, "SVG")),
      afterMove: inspect(moved.analyzedHtml), modules: duplicate.modules.length,
      titles: duplicate.slots.filter((slot) => slot.value === "可编辑的标题").length,
      sourceUnchanged: duplicate.sourceHtml === state.sourceHtml,
      resetModules: api.pristineTemplateState(duplicate).modules.length,
    };
  }, svgTemplate);
  for (const inspected of [result.beforeExport, result.afterExport, result.afterMove]) {
    expect(inspected.svgCount).toBe(2);
    expect(inspected.uniqueIds).toBe(true);
    expect(inspected.references).toHaveLength(2);
    for (const reference of inspected.references) {
      expect(reference.count).toBeGreaterThanOrEqual(4);
      expect(reference.local).toBe(true);
    }
  }
  expect(result).toMatchObject({ modules: 3, titles: 2, sourceUnchanged: true, resetModules: 2 });
});

test("SVG image previews use the image proxy without changing use references or exports", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(async () => {
    const modulePath = "/app/studio/preview-assets.ts";
    const { preparePreviewHtml } = await import(/* @vite-ignore */ modulePath);
    const source = `<section><p>含 SVG 图片的正文</p><svg viewBox="0 0 200 100">
      <defs><rect id="box" width="20" height="20"/></defs><use href="#box"/>
      <image href="https://mmbiz.qpic.cn/example-one.png" width="100" height="100"/>
      <image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://img.xiumi.us/example-two.png" x="100" width="100" height="100"/>
    </svg></section>`;
    const api = window.opTest;
    const state = api.analyzeTemplateHtml(source, "SVG 图片");
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: state };
    const rendered = api.renderProject(project);
    const preview = preparePreviewHtml(rendered);
    const doc = new DOMParser().parseFromString(preview, "text/html");
    const imageUrls = [...doc.querySelectorAll("image")].map((image) => [...image.attributes].find((attribute) => attribute.localName === "href")?.value || "");
    const localRef = doc.querySelector("use")?.getAttribute("href") || "";
    const exported = api.wrapStandaloneHtml(api.renderProject(project), "SVG 图片");
    return {
      imageUrls, localRefValid: localRef.startsWith("#") && Boolean(doc.getElementById(localRef.slice(1))),
      idempotent: preparePreviewHtml(preview) === preview,
      exportHasProxy: exported.includes("/local-api/assets/proxy"),
      sourceHasProxy: state.sourceHtml.includes("/local-api/assets/proxy"),
      exportHasOriginals: exported.includes("https://mmbiz.qpic.cn/example-one.png") && exported.includes("https://img.xiumi.us/example-two.png"),
    };
  });
  expect(result.imageUrls).toEqual([
    "/local-api/assets/proxy?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fexample-one.png",
    "/local-api/assets/proxy?url=https%3A%2F%2Fimg.xiumi.us%2Fexample-two.png",
  ]);
  expect(result).toMatchObject({ localRefValid: true, idempotent: true, exportHasProxy: false, sourceHasProxy: false, exportHasOriginals: true });
});

test("exported duplicate SVG modules respond only to their own click target", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const api = window.opTest;
    const source = `<article><section class="tn-comp-top-level"><p>独立点击卡片</p>
      <svg width="120" height="30" viewBox="0 0 120 30">
        <rect id="opslion-svg-1-1" width="20" height="30" fill="#a6d5f3"/>
        <rect x="50" width="10" height="30" fill="#8844aa"><animate attributeName="width" from="10" to="60" begin="opslion-svg-1-1.click" dur="0.05s" fill="freeze"/></rect>
      </svg></section><section class="tn-comp-top-level"><p>尾部正文</p></section></article>`;
    const state = api.analyzeTemplateHtml(source, "独立动画");
    const duplicate = api.duplicateTemplateModule(state, state.modules[0].id);
    const project = { ...api.createDefaultProject(), mode: "clone" as const, cloneTemplate: duplicate };
    const exported = api.wrapStandaloneHtml(api.renderProject(project), "独立动画");
    const doc = new DOMParser().parseFromString(exported, "text/html");
    const host = document.createElement("div");
    host.id = "svg-clone-events";
    host.innerHTML = doc.body.innerHTML;
    document.body.append(host);
    return {
      ids: [...host.querySelectorAll("svg [id]")].map((node) => node.id),
      begins: [...host.querySelectorAll("animate")].map((node) => node.getAttribute("begin")),
    };
  });
  expect(result).toEqual({ ids: ["opslion_svg_1_1", "opslion_svg_2_1"], begins: ["opslion_svg_1_1.click", "opslion_svg_2_1.click"] });
  const width = (index: number) => page.evaluate((cardIndex) => {
    const svg = document.querySelectorAll("#svg-clone-events svg")[cardIndex];
    return svg.querySelectorAll("rect")[1].width.animVal.value;
  }, index);
  await page.locator("#svg-clone-events svg").nth(1).locator("rect").first().click();
  await expect.poll(() => width(1)).toBeCloseTo(60, 0);
  expect(await width(0)).toBe(10);
  await page.locator("#svg-clone-events svg").first().locator("rect").first().click();
  await expect.poll(() => width(0)).toBeCloseTo(60, 0);
});
