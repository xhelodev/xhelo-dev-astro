import type { APIRoute } from "astro";
import { getUpstashConfig, saveSharedTrack, validateLofiTrack } from "../../lib/lofi/track-store";
import { checkRateLimit, getClientIp } from "../../lib/lofi/rate-limit";

export const prerender = false;

// Same shape as /api/lofi but a separate budget: distinct key prefix, so
// shares never eat the AI-generation allowance (and vice versa).
const RATE_LIMIT = { keyPrefix: "lofi:share", max: 10, windowMs: 10 * 60 * 1000 };

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
  const limit = await checkRateLimit(ip, RATE_LIMIT);
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
