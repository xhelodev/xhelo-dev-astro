import type { APIRoute } from "astro";
import { getUpstashConfig, isTrackId, loadSharedTrack } from "../../../lib/lofi/track-store";
import { checkRateLimit, getClientIp } from "../../../lib/lofi/rate-limit";

export const prerender = false;

// Reads get a wider budget than writes: refreshing a shared link page counts
// here, and a viral link must not lock readers out after a few refreshes.
const READ_RATE_LIMIT = { keyPrefix: "lofi:read", max: 30, windowMs: 10 * 60 * 1000 };

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
  const limit = await checkRateLimit(ip, READ_RATE_LIMIT);
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
