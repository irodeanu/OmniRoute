import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sendAntigravityRequest,
  tryCreditsRetry,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";
import {
  __resetReactiveModelSyncForTests,
  __setReactiveSyncFnForTests,
} from "../../src/lib/providerModels/reactiveModelSync.ts";

// The Antigravity request payload is finite JSON even when the response is streamed, so every
// physical send (first attempt, Google One AI credits retry) must carry a replayable
// string body with no `duplex` upload stream (#5770 follow-up).

const STREAM_BODY = {
  project: "aicode-consumers",
  requestId: "agent-test",
  request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  model: "gemini-2.5-flash",
  userAgent: "antigravity",
  requestType: "agent",
};

function sendStream(headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return sendAntigravityRequest(
    "antigravity",
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    "gemini-2.5-flash",
    headers,
    { ...STREAM_BODY },
    { accessToken: "token", projectId: "aicode-consumers" },
    true,
    null,
    { debug() {}, info() {}, warn() {}, error() {} },
    0,
    { value: 0 },
    "agent-test"
  );
}

test("Antigravity streaming sends finite JSON as a replayable fixed request body", async () => {
  const originalFetch = globalThis.fetch;
  const sends: Array<{ body: BodyInit | null | undefined; duplex: unknown }> = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sends.push({
      body: init?.body,
      duplex: (init as (RequestInit & { duplex?: unknown }) | undefined)?.duplex,
    });
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  try {
    const result = await sendStream();

    assert.equal(result.response.status, 200);
    assert.equal(sends.length, 1);
    assert.equal(typeof sends[0]?.body, "string");
    assert.equal(sends[0]?.duplex, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Consumer accounts are assigned Google's shared `aicode-consumers` project. Sending it as
// `x-goog-user-project` was always refused (403 USER_PROJECT_DENIED) and the old fallback
// re-sent every request without the header: two upstream calls per logical request. The
// official clients never send that header, so neither do we, and a 403 is not re-sent.
test("Antigravity never sends x-goog-user-project and does not re-send on 403", async () => {
  const originalFetch = globalThis.fetch;
  const sends: Array<Record<string, string>> = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sends.push({ ...(init?.headers as Record<string, string>) });
    return new Response(
      JSON.stringify({ error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const result = await sendStream({
      "Content-Type": "application/json",
      "X-Goog-User-Project": "inbound-client-value",
    });

    assert.equal(result.response.status, 403);
    assert.equal(sends.length, 1, "a 403 must not trigger a second physical send");
    for (const name of Object.keys(sends[0] ?? {})) {
      assert.notEqual(name.toLowerCase(), "x-goog-user-project");
    }
    for (const name of Object.keys(result.finalHeaders)) {
      assert.notEqual(name.toLowerCase(), "x-goog-user-project");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Antigravity credits retry also keeps a streaming request body replayable", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: BodyInit | null | undefined;
  let capturedDuplex: unknown;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body;
    capturedDuplex = (init as (RequestInit & { duplex?: unknown }) | undefined)?.duplex;
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  try {
    const result = await tryCreditsRetry(
      "antigravity",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      { "Content-Type": "application/json" },
      {
        project: "project-1",
        requestId: "agent-test-credits",
        request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
        model: "gemini-2.5-flash",
        userAgent: "antigravity",
        requestType: "agent",
      },
      { accessToken: "token", projectId: "project-1" },
      true,
      null,
      { debug() {}, info() {}, warn() {}, error() {} },
      "account-1",
      () => {},
      { value: 0 },
      "agent-test-credits"
    );

    assert.equal(result?.response.status, 200);
    assert.equal(typeof capturedBody, "string");
    assert.equal(capturedDuplex, undefined);
    assert.match(String(capturedBody), /"enabledCreditTypes":\["GOOGLE_ONE_AI"\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Antigravity 404 reactive-sync retry (#13739) also sends a replayable fixed body", async () => {
  const originalFetch = globalThis.fetch;
  const sends: Array<{ body: BodyInit | null | undefined; duplex: unknown }> = [];
  __resetReactiveModelSyncForTests();
  let syncs = 0;
  __setReactiveSyncFnForTests(async () => {
    syncs += 1;
    return true;
  });

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sends.push({
      body: init?.body,
      duplex: (init as (RequestInit & { duplex?: unknown }) | undefined)?.duplex,
    });
    if (sends.length === 1) {
      return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;

  try {
    const counter = { value: 0 };
    const result = await sendAntigravityRequest(
      "antigravity",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "gemini-2.5-flash",
      { "Content-Type": "application/json" },
      {
        project: "project-1",
        requestId: "agent-test-404",
        request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
        model: "gemini-2.5-flash",
        userAgent: "antigravity",
        requestType: "agent",
      },
      { accessToken: "token", projectId: "project-1", connectionId: "conn-404" },
      true,
      null,
      { debug() {}, info() {}, warn() {}, error() {} },
      0,
      counter,
      "agent-test-404"
    );

    assert.equal(syncs, 1, "a 404 must await one reactive discovery sync");
    assert.equal(result.response.status, 200);
    assert.equal(sends.length, 2, "a successful sync must retry once");
    assert.equal(counter.value, 2, "the retry is counted as a physical send");
    for (const send of sends) {
      assert.equal(typeof send.body, "string");
      assert.equal(send.duplex, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
    __setReactiveSyncFnForTests(null);
    __resetReactiveModelSyncForTests();
  }
});
