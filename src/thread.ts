/* One chat thread. Cloudflare runs exactly one instance per thread name, so its history (in this object's own
 * SQLite database) can't mix with anyone else's, and two tabs on the same thread can't interleave a reply. */
import { DurableObject } from "cloudflare:workers";
import { createAI } from "agents/models/ai-sdk";
import { isStepCount, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { calculate } from "./calc";
import { MARK, rules } from "./prompt";

const HISTORY = 6; // earlier exchanges sent back as context
const MAX_Q = 4000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…[truncated]" : s);

// The answer the page shows: everything after the @answer line, minus the follow-up suggestions.
function answerOf(text: string) {
  const lines = text.split("\n");
  const at = lines.findIndex(l => /^\s*@answer\s*$/.test(l));
  let body = (at === -1 ? lines.filter(l => !/^\s*@/.test(l)) : lines.slice(at + 1)).join("\n");
  const k = body.indexOf(MARK);
  if (k !== -1) body = body.slice(0, k);
  return body.trim();
}

function pageText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export class Thread extends DurableObject<Env> {
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT NOT NULL, a TEXT NOT NULL, ts INTEGER NOT NULL)`);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/api/thread" && req.method === "GET") return this.history();
    if (path === "/api/thread" && req.method === "DELETE") { this.ctx.storage.sql.exec("DELETE FROM messages"); return new Response(null, { status: 204 }); }
    if (path === "/api/chat" && req.method === "POST") return this.chat(req);
    return new Response("Not found", { status: 404 });
  }

  private exchanges(limit: number) {
    return this.ctx.storage.sql
      .exec<{ q: string; a: string }>("SELECT q, a FROM (SELECT id, q, a FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id", limit)
      .toArray();
  }

  private history() {
    return Response.json({ exchanges: this.exchanges(HISTORY) }, { headers: { "cache-control": "no-store" } });
  }

  private async chat(req: Request): Promise<Response> {
    const body = await req.json<{ q?: unknown; ctx?: Record<string, unknown> }>().catch(() => null);
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    if (!q || q.length > MAX_Q) return Response.json({ error: "bad_message" }, { status: 400 });
    if (this.running) return Response.json({ error: "busy" }, { status: 409 });
    this.running = true;

    const c = body?.ctx ?? {};
    const str = (v: unknown, n = 80) => (typeof v === "string" ? v.slice(0, n) : "");
    const where = { local_time: str(c.time), timezone: str(c.tz), language: str(c.lang, 20), country: str(req.cf?.country as string, 4) };

    const messages: ModelMessage[] = [];
    for (const x of this.exchanges(HISTORY)) messages.push({ role: "user", content: x.q }, { role: "assistant", content: clip(x.a, 6000) });
    messages.push({ role: "user", content: q });

    const env = this.env;
    const tools = {
      web_search: tool({
        description: "Searches the web (Exa) and returns current results with titles, URLs and excerpts. Use for anything recent, factual, about people, products, prices, events or anything you are not sure about.",
        inputSchema: z.object({ query: z.string().min(1).max(400).describe("A focused search query") }),
        execute: async ({ query }) => {
          const res = await env.AI.websearch({ gatewayId: env.GATEWAY_ID, query, provider: "exa", limit: 6 });
          if (!res.ok) throw new Error(`Search failed (${res.status})`);
          const { items = [] } = await res.json<{ items?: { title?: string; url: string; description?: string }[] }>();
          return items.map(i => ({ title: i.title, url: i.url, excerpt: clip(i.description ?? "", 600) }));
        },
      }),
      web_fetch: tool({
        description: "Fetches one web page by URL and returns its text. Use to read a search result in full, or a link the user gave you.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https links can be read");
          const res = await fetch(url, { headers: { "user-agent": "VisualAgentChat/1.0", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`The page returned ${res.status}`);
          const type = res.headers.get("content-type") || "";
          if (!/text\/|json|xml/.test(type)) throw new Error(`Can't read ${type || "this kind of file"}`);
          const raw = (await res.text()).slice(0, 600_000);
          return { url: res.url, text: clip(/html/.test(type) ? pageText(raw) : raw, 12_000) };
        },
      }),
      calculate: tool({
        description: "Evaluates one arithmetic expression with + - * / % ^ and parentheses. Use for quick, exact math.",
        inputSchema: z.object({ expression: z.string().max(500) }),
        execute: async ({ expression }) => ({ result: calculate(expression) }),
      }),
    };

    const abort = new AbortController();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter(), enc = new TextEncoder();
    // NDJSON events to the page. If the page goes away (Stop, closed tab), stop paying for the rest of the answer.
    const send = (e: object) => writer.write(enc.encode(JSON.stringify(e) + "\n")).catch(() => abort.abort());

    const run = async () => {
      let full = "", finish = "";
      try {
        const ai = createAI({ binding: env.AI, id: env.GATEWAY_ID });
        const result = streamText({
          model: ai(env.MODEL),
          system: rules(Object.keys(tools), where),
          messages,
          tools,
          stopWhen: isStepCount(8),
          maxOutputTokens: 2500,
          abortSignal: abort.signal,
        });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") { full += part.text; await send({ t: "text", d: part.text }); }
          else if (part.type === "tool-call") await send({ t: "tool", name: part.toolName, input: part.input });
          else if (part.type === "tool-error") await send({ t: "tool_error", name: part.toolName });
          else if (part.type === "finish") finish = part.finishReason;
          else if (part.type === "error") throw part.error;
        }
        const a = answerOf(full);
        if (a && !abort.signal.aborted) this.ctx.storage.sql.exec("INSERT INTO messages (q, a, ts) VALUES (?, ?, ?)", q, a, Date.now());
        await send({ t: "done", truncated: finish === "length" });
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("chat failed", err);
          const msg = String((err as Error)?.message ?? err);
          await send({ t: "error", code: /credit|balance|402|payment/i.test(msg) ? "no_credits" : /429|rate/i.test(msg) ? "rate_limited" : "failed" });
        }
      } finally {
        this.running = false;
        await writer.close().catch(() => {});
      }
    };
    this.ctx.waitUntil(run());

    return new Response(readable, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
}
