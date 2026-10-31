/* Markdown for answers: GitHub-style Markdown (tables, task lists, strikethrough) via marked, LaTeX via KaTeX,
 * and DOMPurify over the result, since answers can echo text from web pages.
 * window.renderMarkdown(src, streaming) -> html. While streaming, half-written tables and unclosed $$ blocks are held back
 * so raw pipes and TeX never flash on screen. Images are dropped on purpose: a model tricked by a web page could
 * otherwise leak chat context through an image URL. */
(() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ready = () => window.marked && window.DOMPurify && window.katex;

  const mathCache = new Map();
  function math(tex, display) {
    const key = (display ? "D" : "I") + tex;
    let html = mathCache.get(key);
    if (html === undefined) {
      try { html = window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", maxSize: 30, maxExpand: 1000 }); }
      catch { html = esc(tex); }
      if (mathCache.size > 500) mathCache.clear();
      mathCache.set(key, html);
    }
    return html;
  }

  // Pulls math out before Markdown sees it (underscores and asterisks in TeX would otherwise become emphasis) and leaves
  // a placeholder. Code spans and fences are skipped. Inline $...$ follows pandoc's rule so prices like "$5 and $10" stay text:
  // no space just inside the dollars, and the closing one isn't followed by a digit.
  function extractMath(src, stash) {
    const put = (tex, display) => { stash.push({ tex, display }); return `@@M${stash.length - 1}@@`; };
    const chunk = s => s
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t.trim(), true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t.trim(), true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t.trim(), false))
      .replace(/(^|[^\\$\w])\$(?!\s)((?:\\.|[^$\\\n])+?)\$(?!\d)/g, (m, pre, t) => (/\s$/.test(t) ? m : pre + put(t, false)));
    return src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((p, i) => (i % 2 ? p : chunk(p))).join("");
  }

  function holdBack(src) {
    if ((src.match(/\$\$/g) || []).length % 2) src = src.slice(0, src.lastIndexOf("$$"));
    for (const [open, close] of [["\\[", "\\]"], ["\\(", "\\)"]]) {
      const o = src.lastIndexOf(open);
      if (o > src.lastIndexOf(close)) src = src.slice(0, o);
    }
    // A table needs its header row and the |---| row before it can render; until then hold the trailing pipe lines back.
    const lines = src.split("\n");
    let k = lines.length;
    while (k > 0 && /^\s*\|/.test(lines[k - 1])) k--;
    const tail = lines.slice(k);
    if (tail.length && !(tail.length >= 2 && /^\s*\|?\s*:?-{2,}/.test(tail[1]))) src = lines.slice(0, k).join("\n");
    return src;
  }

  let configured = false;
  function configure() {
    configured = true;
    window.marked.use({ gfm: true, breaks: false });
    window.DOMPurify.addHook("afterSanitizeAttributes", n => {
      if (n.tagName === "A" && n.getAttribute("href")) { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); }
    });
  }

  window.renderMarkdown = (src, streaming) => {
    if (!ready()) return null; // the page falls back to its small built-in renderer
    if (!configured) configure();
    if (streaming) src = holdBack(src);
    const stash = [];
    let html = window.marked.parse(extractMath(src, stash), { async: false });
    html = window.DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "form", "iframe"], FORBID_ATTR: ["style"] });
    html = html.replace(/@@M(\d+)@@/g, (m, i) => (stash[i] ? math(stash[i].tex, stash[i].display) : m));
    return html.replace(/<table/g, '<div class="tbl"><table').replace(/<\/table>/g, "</table></div>");
  };
})();
