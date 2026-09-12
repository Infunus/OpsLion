import { test, expect } from "@playwright/test";
import { ready } from "./helpers";
test("all HTML boundaries remove active markup and preserve article styles", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const { sanitizeArticleHtml, analyzeTemplateHtml, renderProject, createDefaultProject, wrapStandaloneHtml } = window.opTest;
    const dirty = `<section class="studio-header tn-comp-top-level" id="location" style="padding:18px;color:#123456;position:fixed;z-index:999999;background:url(javascript:alert(1))"><h2>安全标题</h2><p onclick="alert(1)">正文<a href="jav&#x09;ascript:alert(1)">链接</a></p><img src="x" onerror="alert(1)"><img data-src="//mmbiz.qpic.cn/safe.png"><iframe srcdoc="evil"></iframe><svg><a href="javascript:alert(1)"><text>evil</text></a></svg><math><mtext><img src=x onerror=alert(1)></mtext></math><script>alert(1)</script><form><input name="cookie"></form><style>body{display:none}</style></section>`;
    const template = analyzeTemplateHtml(dirty, "测试");
    const project = { ...createDefaultProject(), mode: "clone" as const, cloneTemplate: template };
    // Simulate an unsafe replacement after import; export must clean again.
    const image = template.slots.find((slot) => slot.kind === "image"); if (image) image.value = "data:image/svg+xml,<svg onload=alert(1)>";
    const outputs = [sanitizeArticleHtml(dirty), template.sourceHtml, template.analyzedHtml, renderProject(project), wrapStandaloneHtml(dirty, "标题")];
    return outputs.map((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return { badNodes: doc.querySelectorAll("script,iframe,svg,math,form,input,style").length, unsafe: [...doc.querySelectorAll("*")].flatMap((node) => [...node.attributes]).some((attr) => /^on/i.test(attr.name) || /javascript:|position:\s*fixed|z-index|data:image\/svg/i.test(attr.value)), text: doc.body.textContent, styled: !!doc.querySelector('section[style*="padding: 18px"]'), clobber: !!doc.querySelector("#location,.studio-header") };
    });
  });
  for (const item of result) { expect(item.badNodes).toBe(0); expect(item.unsafe).toBe(false); expect(item.clobber).toBe(false); expect(item.text).toContain("安全标题"); expect(item.styled).toBe(true); }
});
test("project schemas reject corrupt records and unsupported versions", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const { createDefaultProject, projectSchema, parseProjectFile } = window.opTest;
    const project = createDefaultProject();
    let futureRejected = false;
    try { parseProjectFile({ schema: "wechat-agent-studio/project-v99", project }); } catch { futureRejected = true; }
    return { valid: projectSchema.safeParse(project).success, corrupt: projectSchema.safeParse({ ...project, content: { sections: [null] } }).success,
      duplicates: projectSchema.safeParse({ ...project, content: { ...project.content, sections: [project.content.sections[0], project.content.sections[0]] } }).success, futureRejected };
  });
  expect(result).toEqual({ valid: true, corrupt: false, duplicates: false, futureRejected: true });
});

test("safe inline borders, layout spacing and raster backgrounds survive cleaning", async ({ page }) => {
  await ready(page, true);
  const result = await page.evaluate(() => {
    const html = window.opTest.sanitizeArticleHtml('<section style="padding:12px 18px;border-left:3px solid #a0784a;border-bottom:1px dashed #cccccc;border-radius:8px;font-size:15px;line-height:1.85;text-decoration:underline;background-image:url(https://example.test/bg.png)">正文</section>');
    const doc = new DOMParser().parseFromString(html, "text/html"); const style = doc.querySelector("section")!.style;
    return { left: style.borderLeft, bottom: style.borderBottom, padding: style.padding, radius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, decoration: style.textDecorationLine, background: style.backgroundImage };
  });
  expect(result).toMatchObject({ left: "3px solid rgb(160, 120, 74)", bottom: "1px dashed rgb(204, 204, 204)", padding: "12px 18px", radius: "8px", fontSize: "15px", lineHeight: "1.85", decoration: "underline" });
  expect(result.background).toContain("https://example.test/bg.png");
});
test("requests distinguish timeout, cancellation, retryable HTTP and malformed JSON", async ({ page }) => {
  await ready(page, true);
  await page.route("**/slow", async (route) => { await new Promise((resolve) => setTimeout(resolve, 200)); await route.fulfill({ json: {} }).catch(() => {}); });
  await page.route("**/unavailable", (route) => route.fulfill({ status: 503, body: "Service unavailable" }));
  await page.route("**/malformed", (route) => route.fulfill({ body: "not JSON" }));
  const result = await page.evaluate(async () => {
    const run = async (url: string, options = {}) => { try { await window.opTest.requestJson(url, options); return {}; } catch (reason) { const e = reason as Error & { kind?: string; retryable?: boolean }; return { name: e.name, kind: e.kind, retryable: e.retryable }; } };
    const controller = new AbortController(); controller.abort();
    return [await run("/slow", { timeoutMs: 20 }), await run("/slow", { signal: controller.signal }), await run("/unavailable"), await run("/malformed")];
  });
  expect(result[0]).toMatchObject({ kind: "timeout", retryable: true }); expect(result[1].name).toBe("AbortError");
  expect(result[2]).toMatchObject({ kind: "http", retryable: true }); expect(result[3]).toMatchObject({ kind: "payload", retryable: false });
});
