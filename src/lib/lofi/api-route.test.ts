import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../pages/api/lofi";

type RouteContext = Parameters<typeof POST>[0];

function makeRequest(prompt: string): Request {
  return new Request("http://localhost/api/lofi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

function makeContext(prompt: string, ip: string): RouteContext {
  return { request: makeRequest(prompt), clientAddress: ip } as unknown as RouteContext;
}

function stubUpstreamFetch(handler: (init: RequestInit) => Response) {
  const captured: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return captured;
}

describe("POST /api/lofi", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.OPENROUTER_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("sends a bounded reasoning budget and enough output tokens to OpenRouter", async () => {
    const captured = stubUpstreamFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
    );

    await POST(makeContext("rainy tokyo night", "10.0.0.1"));

    expect(captured.length).toBe(1);
    const payload = captured[0]!;
    expect(payload.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it("returns 502 when the model returns empty content", async () => {
    stubUpstreamFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
          { status: 200 },
        ),
    );

    const res = await POST(makeContext("rainy tokyo night", "10.0.0.2"));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("AI returned an empty composition.");
  });
});
