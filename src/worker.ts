/* Edge entry: gives each visitor an anonymous id, then hands /api/* to that visitor's thread object.
 * Nothing about a conversation lives in this module's scope: one isolate serves many visitors at once. */
export { Thread } from "./thread";

const COOKIE = "vac_uid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

function visitor(req: Request) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const id = m?.[1] ?? "";
  return UUID.test(id) ? { id, fresh: false } : { id: crypto.randomUUID(), fresh: true };
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const who = visitor(req);
    const thread = url.searchParams.get("thread") ?? "";
    if (!UUID.test(thread)) return json({ error: "bad_thread" }, 400);

    let res: Response;
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { success } = await env.LIMITER.limit({ key: who.id });
      if (!success) return json({ error: "rate_limited" }, 429);
    }
    if (url.pathname === "/api/chat" || url.pathname === "/api/thread") {
      // The visitor id is part of the object's name, so a guessed thread id can only ever reach your own thread.
      const stub = env.THREAD.get(env.THREAD.idFromName(`${who.id}:${thread}`));
      res = await stub.fetch(req);
    } else {
      res = json({ error: "not_found" }, 404);
    }

    if (!who.fresh) return res;
    const out = new Response(res.body, res);
    const secure = url.protocol === "https:" ? "; Secure" : "";
    out.headers.append("set-cookie", `${COOKIE}=${who.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    return out;
  },
} satisfies ExportedHandler<Env>;
