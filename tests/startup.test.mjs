import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
