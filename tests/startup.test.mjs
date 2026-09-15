import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("force restart recognizes other OpsLion copies but rejects unrelated servers and forged arguments", { skip: process.platform !== "win32" }, async () => {
  const fixtureParent = path.join(root, "work");
  await mkdir(fixtureParent, { recursive: true });
  const fixture = await mkdtemp(path.join(fixtureParent, "startup-"));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  try {
    for (const [folder, name] of [["Other OpsLion", "opslion"], ["Unrelated App", "another-app"]]) {
      const project = path.join(fixture, folder);
      await mkdir(path.join(project, "app", "studio"), { recursive: true });
      await mkdir(path.join(project, "scripts"), { recursive: true });
      await writeFile(path.join(project, "package.json"), JSON.stringify({ name }));
      await writeFile(path.join(project, "app", "studio", "StudioApp.tsx"), "");
      await writeFile(path.join(project, "scripts", "local_bridge.py"), "");
    }
    const other = path.join(fixture, "Other OpsLion");
    const unrelated = path.join(fixture, "Unrelated App");
    const studioCommand = (project) => `node "${path.join(project, "node_modules", ".bin", "..", "vinext", "dist", "cli.js")}" dev`;
    const bridgeCommand = (project) => `python "${path.join(project, "scripts", "local_bridge.py")}"`;
    const script = `
      . ${quote(path.join(root, "scripts", "local-process.ps1"))}
      $checks = @(
        (Get-LocalProcessRole ${quote(root)} 'node.exe' ${quote(studioCommand(other))}),
        (Get-LocalProcessRole ${quote(root)} 'node.exe' ${quote(studioCommand(other))} -AllowOtherProjects),
        (Get-LocalProcessRole ${quote(root)} 'python.exe' ${quote(bridgeCommand(other))} -AllowOtherProjects),
        (Get-LocalProcessRole ${quote(root)} 'node.exe' ${quote(studioCommand(unrelated))} -AllowOtherProjects),
        (Get-LocalProcessRole ${quote(root)} 'python.exe' ${quote(bridgeCommand(unrelated))} -AllowOtherProjects),
        (Get-LocalProcessRole ${quote(root)} 'node.exe' ${quote(`node unrelated.js --example "${path.join(root, "node_modules", "vinext", "dist", "cli.js")}"`)} -AllowOtherProjects),
        (Get-LocalProcessRole ${quote(root)} 'python.exe' ${quote(`python unrelated.py --example "${path.join(root, "scripts", "local_bridge.py")}"`)} -AllowOtherProjects)
      )
      ConvertTo-Json -InputObject $checks -Compress
    `;
    const result = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
    assert.deepEqual(JSON.parse(result.trim()), ["", "studio", "bridge", "", "", "", ""]);
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(fixtureParent) + path.sep));
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Windows launcher process checks reject foreign projects and unrelated Node/Python programs", { skip: process.platform !== "win32" }, () => {
  const script = `
    . '${path.join(root, "scripts/local-process.ps1").replaceAll("'", "''")}'
    $checks = @(
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'node.exe' 'node "D:\\Work\\OpsLion\\node_modules\\.bin\\..\\vinext\\dist\\cli.js" dev'),
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'python.exe' 'python "D:\\Work\\OpsLion\\scripts\\local_bridge.py"'),
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'node.exe' 'node "D:\\Other\\node_modules\\vinext\\dist\\cli.js" dev'),
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'python.exe' 'python "D:\\Work\\OpsLion\\scripts\\other.py"'),
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'node.exe' 'node "D:\\Work\\OpsLion-copy\\node_modules\\vinext\\dist\\cli.js" dev'),
      (Get-LocalProcessRole 'D:\\Work\\OpsLion' 'python.exe' 'python "D:\\Work\\OpsLion\\scripts\\local_bridge.py.bak"')
    )
    ConvertTo-Json -InputObject $checks -Compress
  `;
  const result = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  assert.deepEqual(JSON.parse(result.trim()), ["studio", "bridge", "", "", "", ""]);
});

// BAT launches development mode. Production builds and browser hydration can
// both succeed while the initial development response is an HTTP 500 shell.
test("BAT development entry serves real studio HTML before browser JavaScript runs", { timeout: 45_000 }, async () => {
  const server = await createServer({
    root, configFile: path.join(root, "vite.config.ts"),
    cacheDir: path.join(root, "node_modules", ".vite-startup-test"),
    server: { port: 0, strictPort: false, open: false },
  });
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const html = await response.text();
      assert.equal(response.status, 200, "The BAT health probe must receive HTTP 200");
      assert.ok(html.includes('class="studio-shell"'), "The server must render the workbench itself");
      assert.ok(!html.includes('id="__next_error__"'), "Client hydration must not hide a failed server render");
    }
  } finally { await server.close(); }
});
