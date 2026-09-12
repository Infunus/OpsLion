import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import JSZip from "jszip";
const source = new URL("../integrations/xiumi-bridge/", import.meta.url);
const zip = new JSZip();
for (const filename of (await readdir(source)).sort()) zip.file(filename, await readFile(new URL(filename, source)));
await mkdir(new URL("../public/downloads/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/downloads/xiumi-bridge-extension.zip", import.meta.url), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`Packaged ${Object.keys(zip.files).length} extension files.`);
