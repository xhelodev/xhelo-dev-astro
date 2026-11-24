import type { APIRoute } from "astro";
import { getUpstashConfig, isTrackId, loadSharedTrack } from "../../../lib/lofi/track-store";

export const prerender = false;

// Reads get a wider budget than writes: refreshing a shared link page counts
// here, and a viral link must not lock readers out after a few refreshes.
const READ_RATE_LIMIT_MAX = 30;
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
  if (recent.length >= READ_RATE_LIMIT_MAX) {
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

/** Returns a shared track (and slides its TTL) for `?t=<id>` share links. */
export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const config = getUpstashConfig();
  if (!config) {
    return jsonResponse({ error: "Shared-track cache is not configured." }, 503);
  }

  const id = params?.id;
  if (!isTrackId(id)) {
    return jsonResponse({ error: "Invalid track id." }, 400);
  }

  const ip = getClientIp(request, clientAddress);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return jsonResponse(
      { error: "Too many requests. Please wait a bit before retrying." },
      429,
      { "Retry-After": String(limit.retryAfterSec) },
    );
  }

  const track = await loadSharedTrack(config, id);
  if (!track) {
    // Missing key: never stored, or expired because nobody opened it for 7
    // days (sliding TTL).
    return jsonResponse({ error: "Track not found or expired." }, 404);
  }
  return jsonResponse({ track }, 200);
};
