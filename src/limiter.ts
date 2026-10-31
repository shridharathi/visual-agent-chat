/* Exact sliding-window counter. One instance per key (an IP or a visitor id), so the count is strongly consistent
 * everywhere; Cloudflare's built-in rate-limit binding is only approximate and let ~92% of a 600-request burst through. */
import { DurableObject } from "cloudflare:workers";

export class Limiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)");
  }

  /** Records a request and returns true if fewer than `limit` happened in the last `windowMs`; refused requests aren't recorded. */
  async hit(limit: number, windowMs: number): Promise<boolean> {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM hits WHERE ts <= ?", now - windowMs);
    if (sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM hits").one().c >= limit) return false;
    sql.exec("INSERT INTO hits (ts) VALUES (?)", now);
    return true;
  }
}
