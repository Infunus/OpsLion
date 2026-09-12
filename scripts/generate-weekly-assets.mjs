import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// Neutral, reproducible illustrations for the public weekly template.
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/assets/hello-week");
const drawings = {
  banner: [800, 260, `<rect width="800" height="260" rx="24" fill="#eaf2fc"/><rect x="36" y="36" width="182" height="166" rx="18" fill="#89b1e6"/><rect x="50" y="50" width="154" height="120" rx="10" fill="#fff"/><text x="127" y="132" font-size="60" font-weight="700" text-anchor="middle">W</text><path d="M102 202h50m-25-26v26" stroke="#fff" stroke-width="10" stroke-linecap="round"/><text x="252" y="126" font-size="66" font-weight="700">Hello Week</text><text x="258" y="176" font-size="20" letter-spacing="5" fill="#337ab7">READ · SHARE · DISCOVER</text>`],
  welcome: [360, 300, `<rect width="360" height="300" rx="36" fill="#f6f9fd"/><circle cx="180" cy="100" r="52" fill="#ffe89b"/><path d="m158 92 17 20 31-37" fill="none" stroke="#0f1330" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="180" y="212" text-anchor="middle" font-size="38" font-weight="700">WELCOME</text><text x="180" y="250" text-anchor="middle" font-size="17" letter-spacing="4" fill="#337ab7">A NEW WEEK</text>`],
  "submission-qr": [360, 360, `<rect x="8" y="8" width="344" height="344" rx="22" fill="#fff" stroke="#89b1e6" stroke-width="4" stroke-dasharray="12 8"/><rect x="132" y="84" width="96" height="96" rx="22" fill="#eaf2fc"/><path d="M160 132h40m-20-20v40" stroke="#337ab7" stroke-width="8" stroke-linecap="round"/><text x="180" y="230" text-anchor="middle" font-size="29" font-weight="700">YOUR QR CODE</text><text x="180" y="267" text-anchor="middle" font-size="16" letter-spacing="3" fill="#64778c">PLACEHOLDER</text><text x="180" y="306" text-anchor="middle" font-size="14" fill="#64778c">Replace before publishing</text>`],
  avatar: [64, 64, `<circle cx="32" cy="32" r="32" fill="#89b1e6"/><text x="32" y="45" text-anchor="middle" font-size="36" font-weight="700" fill="#fff">W</text>`],
  section: [96, 84, `<path d="M18 5h60a13 13 0 0 1 13 13v38a13 13 0 0 1-13 13H37L20 82V69h-2A13 13 0 0 1 5 56V18A13 13 0 0 1 18 5" fill="#ffe89b"/><circle cx="34" cy="38" r="5"/><circle cx="62" cy="38" r="5"/>`],
  heart: [100, 96, `<path d="M50 85 13 49C-12 19 27-6 50 22 73-6 112 19 87 49Z" fill="#f4b4bd"/>`],
  footer: [800, 220, `<rect width="800" height="220" rx="20" fill="#eaf2fc"/><path d="M52 44h696" stroke="#89b1e6" stroke-width="2"/><text x="400" y="115" text-anchor="middle" font-size="38" font-weight="700">THANKS FOR READING</text><text x="400" y="160" text-anchor="middle" font-size="20" letter-spacing="5" fill="#337ab7">HELLO WEEK</text>`],
};

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, [width, height, drawing]] of Object.entries(drawings)) {
    await page.setViewportSize({ width, height });
    await page.setContent(`<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="#0f1330" font-family="Arial,sans-serif">${drawing}</svg></body></html>`);
    await page.screenshot({ path: path.join(output, `${name}.png`), omitBackground: true });
  }
} finally { await browser.close(); }
console.log(`Generated ${Object.keys(drawings).length} weekly assets.`);
