import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";

test("Windows launchers use CRLF without a byte order mark", async () => {
  for (const path of ["启动排版台.bat", "关闭排版台.bat"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(!source.startsWith("\uFEFF"), `${path}: cmd.exe cannot read a UTF-8 BOM`);
    assert.ok(source.includes("\r\n"), `${path}: missing Windows line endings`);
    assert.ok(!/(?<!\r)\n/.test(source), `${path}: LF-only lines can truncate cmd.exe commands`);
  }
});

test("ships the local launcher, Xiumi extension and agent validator", async () => {
  for (const path of ["public/downloads/xiumi-bridge-extension.zip", "启动排版台.bat", "关闭排版台.bat", "agent/skills/wechat-layout-agent/scripts/validate_plan.py"])
    await access(new URL(`../${path}`, import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../integrations/xiumi-bridge/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.includes("https://mp.weixin.qq.com/*"));
});

test("downloadable Xiumi extension exactly matches its reviewed source", async () => {
  const root = new URL("../integrations/xiumi-bridge/", import.meta.url);
  const zip = await JSZip.loadAsync(await readFile(new URL("../public/downloads/xiumi-bridge-extension.zip", import.meta.url)));
  const files = (await readdir(root)).sort();
  assert.deepEqual(Object.keys(zip.files).filter((key) => !zip.files[key].dir).sort(), files);
  for (const filename of files) assert.deepEqual(await zip.file(filename).async("nodebuffer"), await readFile(new URL(filename, root)), filename);
});
