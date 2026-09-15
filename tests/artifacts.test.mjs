import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("release dependencies are present and Git includes required artifacts while excluding local sessions", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const required = ["public/downloads/xiumi-bridge-extension.zip", "public/weekly/hello-week-template-v1.zip", "skills/Xiumi_Layout_Skill.zip", "skills/Hello_Week_Skill.zip", "integrations/we-mp-rss/manual-refresh.patch", "integrations/we-mp-rss/wechat-authorization.patch", "integrations/we-mp-rss/LICENSE", "integrations/we-mp-rss/UPSTREAM.json", "integrations/weread-mp-fetcher/LICENSE", "scripts/collector-verification.mjs", "scripts/collector-requirements.txt", "docs/weread-fetcher.md", "docs/rss-integration.md"];
  for (const name of required) await access(new URL(`../${name}`, import.meta.url));
  // Download ZIP installations have no Git metadata, but still need all artifacts.
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0) return;
  for (const name of required) {
    const check = spawnSync("git", ["check-ignore", "--no-index", "-q", name], { cwd: root });
    assert.equal(check.status, 1, `${name}: required release file is ignored by Git`);
  }
  for (const name of ["config/local.paths.json", ".local-bridge.log", "private/login-qr.png", "private/verification.json", "private/browser-profiles/msedge/Local State", "private/body-cache/article.json"]) {
    const check = spawnSync("git", ["check-ignore", "--no-index", "-q", name], { cwd: root });
    assert.equal(check.status, 0, `${name}: private runtime data is not excluded`);
  }
});
