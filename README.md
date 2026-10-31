# Visual Agent Chat

**Live:** https://visual-agent-chat.shridharathinarayanan.workers.dev

![Visual Agent Chat: a prompt with a dithered gift shape below it](docs/screenshot.png)

A single-page agent chat. While the model works, a WebGL2 dithered "mind" tile morphs between shapes that match each step it narrates (searching the web, reading a page, calculating), then the answer streams in.

Runs on Cloudflare Workers. Claude Haiku 5.5 and Exa web search both go through **AI Gateway**, billed to your Cloudflare account's AI Gateway credits, so there are no Anthropic or Exa keys to manage.

## How it works

```
browser ── /api/chat ──► Worker ──► Thread Durable Object (one per chat, own SQLite)
                                        │  agent loop (AI SDK + createAI over the AI binding)
                                        ├─► anthropic/claude-haiku-5.5   (AI Gateway)
                                        ├─► web_search → Exa              (AI Gateway Web Search API)
                                        └─► web_fetch, calculate          (in the Worker)
```

- `public/index.html`: the page (HTML, CSS, GLSL shader, JS). Served as a static asset.
- `src/worker.ts`: gives each visitor an anonymous, HttpOnly cookie id, rate-limits messages, and routes `/api/*` to the right thread.
- `src/thread.ts`: the `Thread` Durable Object. Runs the agent loop, streams NDJSON events (text deltas, tool calls) to the page, and stores each finished exchange.
- `public/md.js`: renders answers as full Markdown (tables, task lists, code, quotes) with LaTeX via KaTeX, sanitized with DOMPurify. Images are dropped on purpose so a prompt-injected answer can't leak chat context through an image URL. `public/vendor/` holds the browser builds of marked, DOMPurify and KaTeX (refresh with `npm run vendor`).
- `src/prompt.ts`: the standing instructions (kept on the server so visitors can't change them). `src/calc.ts`: a safe arithmetic parser.

**Threads stay separate.** Each thread is its own Durable Object named `<visitor id>:<thread id>`, so one person's history lives in its own database and can't be reached by guessing another thread id. Requests to one thread run one at a time, so two tabs can't interleave a reply. No conversation state is kept in module scope.

## Run and deploy

1. In the Cloudflare dashboard, load **AI Gateway credits** (AI → AI Gateway → Credits).
2. Create an API token from the **Edit Cloudflare Workers** template and add **Account → Workers AI → Read** and **Account → AI Gateway → Read** and **Run**. Put it in a `.env` file (gitignored): `CLOUDFLARE_API_TOKEN=...` (add `CLOUDFLARE_ACCOUNT_ID=...` if the token covers several accounts).
3. `npm install`, then `npm run dev` for a local server (the AI binding always calls Cloudflare, even locally) or `npm run deploy` to publish.

Settings live in `wrangler.jsonc`: `MODEL` and `GATEWAY_ID`.

## Security

- No keys ship to the browser or sit in the repo: the model and search go through the `AI` binding, billed to your account. Your Cloudflare login stays on your machine.
- Chat requests must come from the site itself (cross-site POSTs get a 403) and are capped at 40 a minute per IP and 20 a minute per visitor. The counters are exact (`src/limiter.ts`, a Durable Object per key); Cloudflare's built-in rate-limit binding was tried first but is only approximate.
- `public/_headers` sets a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and a Referrer-Policy.
- Answers are sanitized with DOMPurify and images are stripped, so a prompt-injected answer can't phone home through an image URL.
- Set a spend limit in the dashboard (AI → AI Gateway → Spend limits) as the real ceiling on cost.

Dithering core adapted from [Paper Shaders](https://shaders.paper.design/dithering) (Apache-2.0).
