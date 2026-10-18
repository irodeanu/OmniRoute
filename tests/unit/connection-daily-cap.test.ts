import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  connectionDailyCapResult,
  connectionPersonalWeek,
  connectionWeeklyCapResult,
  readConnectionDailyCounts,
  readConnectionWeeklyCounts,
  reserveConnectionDailyRequest,
  reserveConnectionRequestCaps,
  resetConnectionDailyCapForTests,
} from "../../open-sse/services/rateLimitManager/connectionDailyCap.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import {
  __resetRateLimitManagerForTests,
  enableRateLimitProtection,
  refreshConnectionRateLimits,
  withRateLimit,
} from "../../open-sse/services/rateLimitManager.ts";

const DAY_MS = 86_400_000;
const noon = Date.UTC(2026, 9, 17, 12, 0, 0);

describe("connection daily cap", () => {
  afterEach(async () => {
    resetConnectionDailyCapForTests();
    await __resetRateLimitManagerForTests();
  });

  it("allows rpd requests on one connection and blocks the next", async () => {
    const first = await reserveConnectionDailyRequest("acct-a", 2, noon);
    const second = await reserveConnectionDailyRequest("acct-a", 2, noon + 1000);
    const third = await reserveConnectionDailyRequest("acct-a", 2, noon + 2000);

    assert.equal(first.allowed, true);
    assert.equal(first.count, 1);
    assert.equal(second.allowed, true);
    assert.equal(second.count, 2);
    assert.equal(third.allowed, false);
    assert.equal(third.count, 2);
  });

  it("reads the current day count without consuming another request", async () => {
    await reserveConnectionDailyRequest("acct-a", 5, noon);
    await reserveConnectionDailyRequest("acct-a", 5, noon);
    const before = await readConnectionDailyCounts(["acct-a", "acct-b"], noon);
    const after = await readConnectionDailyCounts(["acct-a"], noon);

    assert.deepEqual(before, { "acct-a": 2, "acct-b": 0 });
    assert.deepEqual(after, { "acct-a": 2 });
  });

  it("does not share the day budget across connections", async () => {
    await reserveConnectionDailyRequest("acct-a", 1, noon);
    const other = await reserveConnectionDailyRequest("acct-b", 1, noon);
    assert.equal(other.allowed, true);
    assert.equal(other.count, 1);
  });

  it("starts a fresh count on the next UTC day", async () => {
    await reserveConnectionDailyRequest("acct-a", 1, noon);
    const blocked = await reserveConnectionDailyRequest("acct-a", 1, noon + 1000);
    const nextDay = await reserveConnectionDailyRequest("acct-a", 1, noon + DAY_MS);
    assert.equal(blocked.allowed, false);
    assert.equal(nextDay.allowed, true);
    assert.equal(nextDay.count, 1);
  });

  it("ignores a missing or non-positive cap", async () => {
    const open = await reserveConnectionDailyRequest("acct-a", 0, noon);
    assert.equal(open.allowed, true);
    assert.equal(open.limit, 0);
  });

  it("the 429 is classified as a daily quota so the account is parked", async () => {
    const decision = await reserveConnectionDailyRequest("acct-a", 1, noon);
    await reserveConnectionDailyRequest("acct-a", 1, noon);
    const blocked = await reserveConnectionDailyRequest("acct-a", 1, noon);
    assert.equal(decision.allowed, true);
    const result = connectionDailyCapResult(blocked);
    assert.equal(result.response.status, 429);
    const body = await result.response.json();
    const fallback = checkFallbackError(
      429,
      body.error.message,
      0,
      null,
      "antigravity",
      result.response.headers
    );
    assert.equal(fallback.shouldFallback, true);
    assert.equal(fallback.dailyQuotaExhausted, true);
    assert.ok((fallback.cooldownMs ?? 0) > 60_000);
  });

  it("withRateLimit stops at rpd without calling upstream, across models", async () => {
    const connectionId = "agy-conn";
    enableRateLimitProtection(connectionId);
    refreshConnectionRateLimits(connectionId, { rpd: 1, rpm: 35, maxConcurrent: 2 });
    let calls = 0;
    const run = (model: string) =>
      withRateLimit("antigravity", connectionId, model, async () => {
        calls += 1;
        return { response: new Response("ok", { status: 200 }) };
      });

    const first = await run("claude-sonnet");
    const second = await run("gemini-pro");
    assert.equal(calls, 1);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 429);
    const body = await second.response.json();
    assert.equal(body.error.code, "CONNECTION_RPD_EXHAUSTED");
  });

  it("leaves requests unlimited when the connection has no rpd", async () => {
    const connectionId = "no-rpd";
    enableRateLimitProtection(connectionId);
    refreshConnectionRateLimits(connectionId, { rpm: 35, maxConcurrent: 2 });
    let calls = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = await withRateLimit("antigravity", connectionId, "claude-sonnet", async () => {
        calls += 1;
        return { response: new Response("ok", { status: 200 }) };
      });
      assert.equal(result.response.status, 200);
    }
    assert.equal(calls, 3);
  });

  it("keeps one account's week from its first request across calendar Monday", async () => {
    const anchor = Date.UTC(2026, 9, 15, 8, 0, 0);
    const calendarMonday = Date.UTC(2026, 9, 19, 0, 0, 0);
    const nextPersonalWeek = anchor + 7 * DAY_MS;
    assert.equal(connectionPersonalWeek(anchor, calendarMonday).startMs, anchor);
    assert.equal(connectionPersonalWeek(anchor, nextPersonalWeek).startMs, nextPersonalWeek);

    const limits = { rpd: 10, rpw: 2, weekAnchorMs: anchor };
    const first = await reserveConnectionRequestCaps("acct-a", limits, anchor);
    const onMonday = await reserveConnectionRequestCaps("acct-a", limits, calendarMonday);
    const blocked = await reserveConnectionRequestCaps("acct-a", limits, calendarMonday + 1000);
    const freshWeek = await reserveConnectionRequestCaps("acct-a", limits, nextPersonalWeek);
    const entry = { id: "acct-a", anchorMs: anchor };

    assert.equal(first.allowed, true);
    assert.equal(onMonday.allowed, true);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.period, "week");
    assert.equal(blocked.resetAtMs, nextPersonalWeek);
    assert.deepEqual(await readConnectionDailyCounts(["acct-a"], calendarMonday), { "acct-a": 1 });
    assert.deepEqual(await readConnectionWeeklyCounts([entry], calendarMonday), { "acct-a": 2 });
    assert.equal(freshWeek.allowed, true);
    assert.equal((await readConnectionWeeklyCounts([entry], nextPersonalWeek))["acct-a"], 1);
  });

  it("does not share one account's week start with another account", async () => {
    const svenAnchor = Date.UTC(2026, 9, 15, 8, 0, 0);
    const ilieAnchor = Date.UTC(2026, 9, 17, 12, 0, 0);
    await reserveConnectionRequestCaps(
      "sven",
      { rpw: 1, weekAnchorMs: svenAnchor },
      ilieAnchor
    );
    const ilie = await reserveConnectionRequestCaps(
      "ilie",
      { rpw: 1, weekAnchorMs: ilieAnchor },
      ilieAnchor
    );
    const svenBlocked = await reserveConnectionRequestCaps(
      "sven",
      { rpw: 1, weekAnchorMs: svenAnchor },
      ilieAnchor + 1000
    );
    assert.equal(ilie.allowed, true);
    assert.equal(svenBlocked.allowed, false);
  });

  it("does not consume a daily slot when the week is already full", async () => {
    const limits = { rpd: 10, rpw: 1, weekAnchorMs: noon };
    await reserveConnectionRequestCaps("acct-a", limits, noon);
    const blocked = await reserveConnectionRequestCaps("acct-a", limits, noon + 1000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.period, "week");
    assert.deepEqual(await readConnectionDailyCounts(["acct-a"], noon), { "acct-a": 1 });
    assert.deepEqual(await readConnectionWeeklyCounts([{ id: "acct-a", anchorMs: noon }], noon), {
      "acct-a": 1,
    });
  });

  it("does not consume a weekly slot when the day is already full", async () => {
    const limits = { rpd: 1, rpw: 10, weekAnchorMs: noon };
    await reserveConnectionRequestCaps("acct-a", limits, noon);
    const blocked = await reserveConnectionRequestCaps("acct-a", limits, noon + 1000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.period, "day");
    assert.deepEqual(await readConnectionWeeklyCounts([{ id: "acct-a", anchorMs: noon }], noon), {
      "acct-a": 1,
    });
  });

  it("the weekly 429 is classified as quota exhaustion so the combo moves on", async () => {
    await reserveConnectionRequestCaps("acct-a", { rpw: 1, weekAnchorMs: noon }, noon);
    const blocked = await reserveConnectionRequestCaps("acct-a", { rpw: 1 }, noon + 1000);
    const result = connectionWeeklyCapResult(blocked);
    assert.equal(result.response.status, 429);
    const body = await result.response.json();
    assert.equal(body.error.code, "CONNECTION_RPW_EXHAUSTED");
    assert.match(body.error.message, /weekly quota/);
    assert.match(body.error.message, /next week/);
    const fallback = checkFallbackError(
      429,
      body.error.message,
      0,
      null,
      "antigravity",
      result.response.headers
    );
    assert.equal(fallback.shouldFallback, true);
    assert.equal(fallback.dailyQuotaExhausted, true);
  });

  it("withRateLimit stops at rpw without calling upstream or spending the day", async () => {
    const connectionId = "agy-week";
    enableRateLimitProtection(connectionId);
    refreshConnectionRateLimits(connectionId, { rpd: 1490, rpw: 1, rpm: 35, maxConcurrent: 2 });
    let calls = 0;
    const run = () =>
      withRateLimit("antigravity", connectionId, "gemini", async () => {
        calls += 1;
        return { response: new Response("ok", { status: 200 }) };
      });
    const first = await run();
    const second = await run();
    assert.equal(calls, 1);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 429);
    const body = await second.response.json();
    assert.equal(body.error.code, "CONNECTION_RPW_EXHAUSTED");
    assert.deepEqual(await readConnectionDailyCounts([connectionId]), { [connectionId]: 1 });
  });
});
