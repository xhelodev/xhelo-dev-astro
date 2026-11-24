import type { APIRoute } from "astro";
import { getUpstashConfig, saveSharedTrack, validateLofiTrack } from "../../lib/lofi/track-store";

export const prerender = false;

// Mirrors the limiter shape of /api/lofi (separate budget: shares vs AI calls).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitStore = new Map<string, number[]>();

function getClientIp(request: Request, clientAddress?: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return clientAddress || "unknown";
}

function checkRateLimit(ip: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateLimitStore.get(ip) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    rateLimitStore.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  rateLimitStore.set(ip, recent);

  // Opportunistic cleanup to avoid unbounded map growth.
  if (rateLimitStore.size > 500) {
    for (const [key, timestamps] of rateLimitStore) {
      const alive = timestamps.filter((ts) => ts > cutoff);
      if (alive.length === 0) rateLimitStore.delete(key);
      else rateLimitStore.set(key, alive);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

function jsonResponse(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/** Saves a validated track to the share cache and returns its short id. */
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const config = getUpstashConfig();
  if (!config) {
    return jsonResponse({ error: "Shared-track cache is not configured." }, 503);
  }

  const ip = getClientIp(request, clientAddress);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return jsonResponse(
      { error: "Too many requests. Please wait a bit before sharing another track." },
      429,
      { "Retry-After": String(limit.retryAfterSec) },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const rawTrack = body && typeof body === "object" ? (body as Record<string, unknown>).track : undefined;
  const track = validateLofiTrack(rawTrack);
  if (!track) {
    return jsonResponse({ error: "Invalid track payload." }, 400);
  }

  const id = await saveSharedTrack(config, track);
  if (!id) {
    console.error("[api/tracks] Upstash SET failed twice (NX miss or transport)");
    return jsonResponse({ error: "Could not save the track. Try again." }, 502);
  }
  return jsonResponse({ id }, 200);
};
