/**
 * Rate limiting for the lofi API routes: a fixed-window counter in Upstash
 * Redis so the budget holds across serverless instances, with the previous
 * per-instance in-memory limiter kept as a fallback when Upstash is not
 * configured or unreachable.
 *
 * Server-only, like track-store: imported by the API routes, never by client
 * code.
 */
import { getUpstashConfig, upstashPipeline, type UpstashConfig } from "./track-store";

export interface RateLimitRule {
  /** Per-route key prefix, e.g. "lofi:gen" — budgets are independent per prefix. */
  keyPrefix: string;
  /** Max requests per window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

const MEMORY_CLEANUP_THRESHOLD = 500;
const memoryStore = new Map<string, number[]>();

/**
 * Resolves the caller IP. The platform-provided `clientAddress` wins: the
 * Vercel adapter fills it from platform-controlled headers, so a client
 * cannot spoof it. The forwarded headers stay as fallbacks for runtimes
 * without `clientAddress` (local dev, the standalone output runner) — never
 * as the preferred source.
 */
export function getClientIp(request: Request, clientAddress?: string): string {
  const platformIp = clientAddress?.trim();
  if (platformIp) return platformIp;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

/** Checks the budget for `ip`, preferring the distributed Upstash counter. */
export async function checkRateLimit(ip: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const config = getUpstashConfig();
  if (config) {
    const distributed = await checkUpstash(config, ip, rule);
    if (distributed) return distributed;
    // Upstash is configured but unreachable: degrade to the per-instance
    // limiter instead of failing open (no cost protection) or closed (outage
    // for every request).
    console.error(`[rate-limit] Upstash limiter unavailable (${rule.keyPrefix}); using in-memory fallback`);
  }
  return checkMemory(`${rule.keyPrefix}:${ip}`, rule);
}

async function checkUpstash(config: UpstashConfig, ip: string, rule: RateLimitRule): Promise<RateLimitResult | null> {
  const now = Date.now();
  const windowSec = Math.ceil(rule.windowMs / 1000);
  // Fixed window: one counter key per window bucket, so the budget resets
  // naturally when the bucket rolls over and the keys expire on their own.
  const bucket = Math.floor(now / rule.windowMs);
  const key = `rl:${rule.keyPrefix}:${ip}:${bucket}`;
  const results = await upstashPipeline(config, [
    ["INCR", key],
    // Plain EXPIRE (no NX): every request refreshes it, so a lost EXPIRE
    // next to a successful INCR self-heals on the next call instead of
    // leaking an immortal key. Bucket keys are unique per window, so the
    // refresh never extends a limit past its own bucket.
    ["EXPIRE", key, String(windowSec + 1)],
  ]);
  const count = results?.[0]?.result;
  if (typeof count !== "number") return null;
  if (count <= rule.max) return { allowed: true, retryAfterSec: 0 };
  const remainingMs = rule.windowMs - (now % rule.windowMs);
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)) };
}

/** Sliding-window fallback, one budget per `${keyPrefix}:${ip}`. */
function checkMemory(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const cutoff = now - rule.windowMs;
  const recent = (memoryStore.get(key) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= rule.max) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
    memoryStore.set(key, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  memoryStore.set(key, recent);

  // Opportunistic cleanup to avoid unbounded map growth. All current rules
  // share a 10-minute window, so one cutoff fits every entry.
  if (memoryStore.size > MEMORY_CLEANUP_THRESHOLD) {
    for (const [mapKey, timestamps] of memoryStore) {
      const alive = timestamps.filter((ts) => ts > cutoff);
      if (alive.length === 0) memoryStore.delete(mapKey);
      else memoryStore.set(mapKey, alive);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}
