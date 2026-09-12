import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public", "weekly");
const zip = new JSZip();
const server = await createServer({ root, configFile: path.join(root, "tests/vite.config.ts"), server: { port: 0, strictPort: false, open: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/tests/browser/harness.html?bare`);
  await page.waitForFunction(() => Boolean(window.opTest?.weeklyTemplate));
  const templates = await page.evaluate(async () => {
    const api = window.opTest.weeklyTemplate;
    const cases = [...api.helloWeekExamples, { id: "all-modules", name: "全部模块", filename: "all-modules.md", text: api.helloWeekModuleShowcase }];
    return {
      definition: api.definition, starter: api.helloWeekStarter,
      examples: cases.map((item) => ({ ...item, ...api.renderHelloWeek(item.text) })),
      packet: await api.createWeeklyBridgePackage(api.renderHelloWeek(api.helloWeekModuleShowcase).html, "Hello Week丨全部模块示例"),
    };
  });
  const definition = JSON.stringify(templates.definition, null, 2) + "\n";
  zip.file("hello-week.template.json", definition);
  zip.file("starter.md", templates.starter);
  zip.file("Hello-Week-example.xiumi.json", JSON.stringify(templates.packet, null, 2));
  for (const asset of Object.values(templates.definition.assets)) zip.file(`assets/${path.basename(asset.src)}`, await readFile(path.join(root, "public", asset.src)));
  for (const example of templates.examples) {
    zip.file(example.id === "all-modules" ? example.filename : `examples/${example.filename}`, example.text);
    const html = example.html.replaceAll("/assets/hello-week/", "../assets/");
    zip.file(`preview/${example.id}.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${example.name}</title><style>body{margin:0;background:#f1f1ef}article{width:390px;max-width:100%;margin:auto;background:#fff}*{box-sizing:border-box}</style></head><body><article>${html}</article></body></html>`);
  }
  zip.file("preview/index.html", `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hello Week 模板预览</title><style>body{margin:32px auto;padding:20px;max-width:620px;font:16px/1.9 system-ui;color:#273530;background:#f7f7f4}a{color:#337ab7}li{margin:12px 0}</style></head><body><h1>Hello Week</h1><p>五种结构与全部模块的合成示例。点击打开完整预览。</p><ul>${templates.examples.map((item) => `<li><a href="${item.id}.html">${item.name}</a> · ${item.newsCount} 条资讯</li>`).join("")}</ul><p>生成文案请使用 hello-week.template.json 中的字段约定，并从 examples/ 选择起步格式。</p></body></html>`);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "hello-week.template.json"), definition);
  await writeFile(path.join(output, "starter.md"), templates.starter);
  await writeFile(path.join(output, "hello-week-template-v1.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log(`Hello Week v${templates.definition.version}: ${templates.examples.length} previews, ${Object.keys(templates.definition.modules).length} modules, ${Object.keys(templates.definition.assets).length} assets → ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
