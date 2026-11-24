import type { APIRoute } from "astro";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  compileAiComposition,
  parseAiComposition,
  sanitizePrompt,
} from "../../lib/lofi/ai-track";
import { checkRateLimit, getClientIp } from "../../lib/lofi/rate-limit";

export const prerender = false;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

// Distributed budget (Upstash fixed window) with in-memory fallback.
const RATE_LIMIT = { keyPrefix: "lofi:gen", max: 10, windowMs: 10 * 60 * 1000 };

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

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const apiKey = import.meta.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "AI music generator is not configured." }, 503);
  }

  const ip = getClientIp(request, clientAddress);
  const limit = await checkRateLimit(ip, RATE_LIMIT);
  if (!limit.allowed) {
    return jsonResponse(
      { error: "Too many requests. Please wait a bit before generating another track." },
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

  const rawPrompt =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).prompt === "string"
      ? (body as Record<string, unknown>).prompt as string
      : "";
  const prompt = sanitizePrompt(rawPrompt);
  if (prompt.length < 2) {
    return jsonResponse({ error: "Please enter a style prompt (at least 2 characters)." }, 400);
  }

  const model = (import.meta.env.OPENROUTER_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL).trim();
  const origin = request.headers.get("origin") ?? "https://xhelo.dev";

  const baseBody = {
    model,
    temperature: 0.85,
    // Reasoning-capable models spend tokens thinking before the JSON answer; a
    // low budget starves content to null. Attempt 1 bounds reasoning; attempt 2
    // (only when content comes back empty) disables it so the whole budget goes
    // to the JSON composition itself.
    max_tokens: 6000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(prompt) },
    ],
  };
  const attempts: Array<Record<string, unknown>> = [
    { ...baseBody, reasoning: { effort: "low" } },
    { ...baseBody, reasoning: { enabled: false } },
  ];

  try {
    let content: string | null = null;
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": origin,
          "X-Title": "16-BIT RADIO Music Generator",
        },
        body: JSON.stringify(attempts[attempt]),
        signal: AbortSignal.timeout(45_000),
      });

      if (!upstream.ok) {
        console.error(`[api/lofi] OpenRouter error: status=${upstream.status} (attempt ${attempt + 1}/2)`);
        return jsonResponse({ error: "Upstream AI provider returned an error." }, 502);
      }

      const data = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: unknown;
        error?: unknown;
      };
      const candidate = data.choices?.[0]?.message?.content;
      if (candidate) {
        content = candidate;
        break;
      }
      console.error(
        `[api/lofi] Empty completion content (attempt ${attempt + 1}/2): ${JSON.stringify({
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          usage: data.usage ?? null,
          upstream_error: data.error ?? null,
        })}`,
      );
    }

    if (!content) {
      return jsonResponse({ error: "AI returned an empty composition." }, 502);
    }

    const composition = parseAiComposition(content, prompt);
    const track = compileAiComposition(composition);
    return jsonResponse({ track, model }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const cause = err instanceof Error && err.cause instanceof Error ? `; cause: ${err.cause.message}` : "";
    console.error(`[api/lofi] Generation failed: ${message}${cause}`);
    return jsonResponse({ error: "Could not generate a valid track. Try again." }, 502);
  }
};
