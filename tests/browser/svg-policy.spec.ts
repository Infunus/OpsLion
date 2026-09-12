import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

test("Xiumi SVG geometry, XHTML labels and click/touch animations survive repeated cleaning", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const source = `<section><svg width="100.00%" viewBox="0 0 900 183" opacity="1" style="box-sizing:border-box;transform:rotateZ(0deg);display:block;max-width:none!important;pointer-events:none;isolation:isolate">
      <svg width="100%" height="100%"><rect fill="rgb(254,254,254)" width="100%" height="100%" x="0%" y="0%" pointer-events="visible"/>
      <svg x="5%" y="26.76%" width="90%" height="46.49%"><foreignObject width="100%" height="100%" style="pointer-events:none;color:rgb(166,213,243);font-size:330.91%;text-align:center"><p xmlns="http://www.w3.org/1999/xhtml"><strong>点击展开推文</strong></p></foreignObject></svg></svg>
      <animate fill="freeze" attributeName="opacity" begin="click" from="1" to="0" dur="0.1" restart="never"/>
      <animate attributeName="height" begin="click + 0.1s" dur="1" restart="never"/>
      <animate attributeName="width" from="100%" to="1938.8111016991381%" begin="click + 0.1s" dur="1s"/>
      <animate attributeName="opacity" from="0" to="1" begin="touchstart+1s" dur="0.1s"/>
      <animateTransform attributeName="transform" type="translate" values="-9999 0; -9999 0; -900 0" begin="click" dur="1s" fill="freeze" keyTimes="0;0.99;1" calcMode="discrete"/>
      <animateTransform attributeName="transform" type="translate" values="0 0;900 0" begin="touchstart" dur="1.1s"/>
      <set attributeName="visibility" to="hidden" begin="touchstart" dur="0.21s" fill="remove"/>
    </svg></section>`;
    const clean = window.opTest.sanitizeArticleHtml(source);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    const svg = doc.querySelector("svg")!;
    const label = doc.querySelector("foreignObject p")!;
    return {
      clean, repeated: window.opTest.sanitizeArticleHtml(clean), viewBox: svg.getAttribute("viewBox"),
      svgNamespace: svg.namespaceURI, labelNamespace: label.namespaceURI, label: label.textContent,
      animations: [...doc.querySelectorAll("animate,animateTransform,set")].map((node) => ({ tag: node.localName, target: node.getAttribute("attributeName"), begin: node.getAttribute("begin") })),
      maxWidthPriority: svg.style.getPropertyPriority("max-width"), pointerEvents: svg.style.pointerEvents,
      isolation: svg.style.isolation, foreignStyle: doc.querySelector("foreignObject")!.getAttribute("style"),
    };
  });
  expect(result.repeated).toBe(result.clean);
  expect(result.viewBox).toBe("0 0 900 183");
  expect(result.svgNamespace).toBe("http://www.w3.org/2000/svg");
  expect(result.labelNamespace).toBe("http://www.w3.org/1999/xhtml");
  expect(result.label).toBe("点击展开推文");
  expect(result.animations).toHaveLength(7);
  expect(result.animations).toContainEqual({ tag: "animateTransform", target: "transform", begin: "touchstart" });
  expect(result.animations).toContainEqual({ tag: "set", target: "visibility", begin: "touchstart" });
  expect(result.maxWidthPriority).toBe("important");
  expect(result.pointerEvents).toBe("none");
  expect(result.isolation).toBe("isolate");
  expect(result.foreignStyle).toContain("font-size: 330.91%");
});

test("SVG IDs, gradients, local use references and image resources stay scoped and stable", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const source = `<section id="location"><svg viewBox="0 0 100 100"><defs>
      <linearGradient id="location"><stop offset="0%" stop-color="#a6d5f3"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>
      <clipPath id="clip"><rect width="90" height="90"/></clipPath><path id="shape" d="M0 0L100 100"/></defs>
      <rect width="100" height="100" fill="url(#location)" style="clip-path:url(#clip);stroke:url(#location)"/>
      <use href="#shape"/><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#shape"/>
      <image href="https://mmbiz.qpic.cn/safe.png" width="10" height="10"/>
      <image xlink:href="/local-api/assets/proxy?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fsafe.png" width="10" height="10"/>
      <animate attributeName="opacity" from="0" to="1" begin="shape.click + 0.1s" dur="1s"/>
    </svg><svg><use href="#shape"/><rect id="shape" width="10" height="10"/></svg></section>`;
    const clean = window.opTest.sanitizeArticleHtml(source);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    const roots = [...doc.querySelectorAll("section > svg")];
    return {
      clean, repeated: window.opTest.sanitizeArticleHtml(clean), outsideId: doc.querySelector("section")!.id,
      ids: [...doc.querySelectorAll("[id]")].map((node) => node.id),
      referencesResolveLocally: roots.every((root) => [...root.querySelectorAll("use")].every((node) => {
        const ref = node.getAttribute("href") || node.getAttribute("xlink:href");
        return !!ref && !!root.querySelector(`[id="${ref.slice(1)}"]`);
      })),
      gradient: roots[0].querySelector("rect[fill]")!.getAttribute("fill"),
      clip: roots[0].querySelector("rect[fill]")!.getAttribute("style"),
      timing: doc.querySelector("animate")!.getAttribute("begin"),
      images: [...doc.querySelectorAll("image")].map((node) => node.getAttribute("href") || node.getAttribute("xlink:href")),
    };
  });
  expect(result.repeated).toBe(result.clean);
  expect(result.outsideId).toBe("");
  expect(new Set(result.ids).size).toBe(result.ids.length);
  expect(result.ids.every((id) => /^opslion_svg_\d+_\d+$/.test(id))).toBe(true);
  expect(result.referencesResolveLocally).toBe(true);
  expect(result.gradient).toMatch(/^url\(#opslion_svg_/);
  expect(result.clip).toContain("clip-path:");
  expect(result.timing).toMatch(/^opslion_svg_\d+_\d+\.click/);
  expect(result.images).toEqual(["https://mmbiz.qpic.cn/safe.png", "/local-api/assets/proxy?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fsafe.png"]);
});

test("SVG cannot animate links, import active foreign content or reference external documents", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const source = `<section id="location" style="position:fixed;z-index:999"><svg onload="alert(1)" viewBox="0 0 100 100">
      <script>alert(1)</script><a href="javascript:alert(1)"><text>active wrapper</text></a>
      <foreignObject><div id="cookie" onclick="alert(1)"><strong>safe label</strong><iframe srcdoc="evil"></iframe><form><input name="location"/></form><img onerror="alert(1)" src="javascript:alert(1)"/></div></foreignObject>
      <use href="https://evil.invalid/payload.svg#item"/><image href="data:image/svg+xml,%3Csvg%20onload=alert(1)%3E"/>
      <rect width="10" height="10" fill="url(https://evil.invalid/payload.svg#paint)" style="filter:url(https://evil.invalid/filter.svg#x)"/>
      <animate attributeName="href" values="https://safe.invalid;javascript:alert(1)"/>
      <animate attributeName="opacity" to="javascript:alert(1)"/>
      <animate attributeName="width" href="#location" to="100"/>
      <animateTransform attributeName="href" type="translate" values="0 0;10 0"/>
      <set attributeName="href" to="javascript:alert(1)"/><set attributeName="visibility" to="url(https://evil.invalid)"/>
      <animate attributeName="opacity" from="0" to="1" begin="accessKey(a)"/>
      <animate attributeName="opacity" from="0" to="1" begin="missing-trigger.click"/>
    </svg></section>`;
    const clean = window.opTest.sanitizeArticleHtml(source);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    return {
      clean, repeated: window.opTest.sanitizeArticleHtml(clean), text: doc.body.textContent,
      activeNodes: doc.querySelectorAll("script,iframe,form,input,animate,animateTransform,set,svg a").length,
      unsafeAttributes: [...doc.querySelectorAll("*")].flatMap((node) => [...node.attributes]).filter((attr) => /^on/i.test(attr.name) || /javascript:|data:image\/svg|evil\.invalid|position:\s*fixed|z-index/.test(attr.value)).map((attr) => attr.name),
      htmlIds: doc.querySelectorAll("section[id],foreignObject [id]").length,
    };
  });
  expect(result.repeated).toBe(result.clean);
  expect(result.activeNodes).toBe(0);
  expect(result.unsafeAttributes).toEqual([]);
  expect(result.htmlIds).toBe(0);
  expect(result.text).toContain("safe label");
  expect(result.text).not.toContain("active wrapper");
});

test("the preserved numeric SVG animation responds to its click trigger", async ({ page }) => {
  await ready(page, true);
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "svg-animation-test";
    host.innerHTML = window.opTest.sanitizeArticleHtml('<svg width="100" height="30"><rect width="10" height="30" fill="#a6d5f3"><animate attributeName="width" from="10" to="80" begin="click" dur="0.05s" fill="freeze"/></rect></svg>');
    document.body.append(host);
  });
  await page.locator("#svg-animation-test rect").click();
  await expect.poll(() => page.evaluate(() => document.querySelector<SVGRectElement>("#svg-animation-test rect")!.width.animVal.value)).toBeCloseTo(80, 0);
  await page.evaluate(() => document.getElementById("svg-animation-test")!.remove());
});

for (const sourceId of ["reading-open", "opslion-svg-1-1", "opslion_svg_1_1"]) {
  test(`normalized SMIL event and syncbase references run after a real click (${sourceId})`, async ({ page }) => {
    await ready(page, true);
    const result = await page.evaluate((id) => {
      const source = `<svg width="390" height="76" viewBox="0 0 390 76">
        <rect id="${id}" width="390" height="76" fill="#a6d5f3"/>
        <animate id="old-expansion" attributeName="viewBox" from="0 0 390 76" to="0 0 390 388" begin="${id}.click" dur="0.05s" fill="freeze"/>
        <animate attributeName="opacity" from="1" to="0.4" begin="old-expansion.end" dur="0.05s" fill="freeze"/>
      </svg>`;
      const clean = window.opTest.sanitizeArticleHtml(source);
      const repeated = window.opTest.sanitizeArticleHtml(clean);
      const host = document.createElement("div");
      host.id = "svg-reference-animation-test";
      host.innerHTML = repeated;
      document.body.append(host);
      return {
        stable: clean === repeated,
        ids: [...host.querySelectorAll("[id]")].map((node) => node.id),
        begins: [...host.querySelectorAll("animate")].map((node) => node.getAttribute("begin")),
        initialHeight: host.querySelector("svg")!.viewBox.animVal.height,
      };
    }, sourceId);
    expect(result).toEqual({
      stable: true, ids: ["opslion_svg_1_1", "opslion_svg_1_2"],
      begins: ["opslion_svg_1_1.click", "opslion_svg_1_2.end"], initialHeight: 76,
    });
    await page.locator("#svg-reference-animation-test rect").click();
    await expect.poll(() => page.evaluate(() => document.querySelector<SVGSVGElement>("#svg-reference-animation-test svg")!.viewBox.animVal.height)).toBeCloseTo(388, 0);
    await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.querySelector("#svg-reference-animation-test svg")!).opacity))).toBeCloseTo(0.4, 2);
  });
}
