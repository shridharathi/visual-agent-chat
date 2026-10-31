// Copies the browser builds of the Markdown, sanitizer and math libraries into public/vendor so the page serves them itself
// (no CDN at runtime). Run after changing versions: npm run vendor
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const out = "public/vendor";
mkdirSync(`${out}/katex/fonts`, { recursive: true });
copyFileSync("node_modules/marked/lib/marked.umd.js", `${out}/marked.umd.js`);
copyFileSync("node_modules/dompurify/dist/purify.min.js", `${out}/purify.min.js`);
copyFileSync("node_modules/katex/dist/katex.min.js", `${out}/katex/katex.min.js`);
copyFileSync("node_modules/katex/dist/katex.min.css", `${out}/katex/katex.min.css`);
// woff2 is enough for every browser that can run this page; the css falls back to files we don't ship, which are never requested.
for (const f of readdirSync("node_modules/katex/dist/fonts").filter(f => f.endsWith(".woff2")))
  copyFileSync(`node_modules/katex/dist/fonts/${f}`, `${out}/katex/fonts/${f}`);
console.log("vendored marked, dompurify, katex");
