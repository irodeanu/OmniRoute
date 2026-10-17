import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-check-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "check-quota-pause-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const pause = await import("../../open-sse/services/antigravityCheckQuotaPause.ts");

const HOUR = 60 * 60 * 1000;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("first check-quota 429 pauses 5h", () => {
  const now = 1_700_000_000_000;
  const next = pause.nextCheckQuotaPause(null, now, null);
  assert.deepEqual(next, { step: 0, pauseMs: 5 * HOUR, duplicate: false });
});

test("a 429 inside the hour after return climbs 5h, 10h, 24h, then stays at 7d", () => {
  const now = 1_700_000_000_000;
  let previous = { step: 0, untilMs: now - 30 * 60 * 1000 };
  const expected = [10 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 7 * 24 * HOUR];
  for (let i = 0; i < expected.length; i++) {
    const next = pause.nextCheckQuotaPause(previous, now, null);
    assert.equal(next.duplicate, false);
    assert.equal(next.pauseMs, expected[i], `step ${i}`);
    previous = { step: next.step, untilMs: now - 30 * 60 * 1000 };
  }
  assert.equal(previous.step, 3);
});

test("a 429 more than an hour after return starts again at 5h", () => {
  const now = 1_700_000_000_000;
  const next = pause.nextCheckQuotaPause(
    { step: 3, untilMs: now - 2 * HOUR },
    now,
    null
  );
  assert.deepEqual(next, { step: 0, pauseMs: 5 * HOUR, duplicate: false });
});

test("a pause that is still running does not climb", () => {
  const now = 1_700_000_000_000;
  const next = pause.nextCheckQuotaPause(
    { step: 0, untilMs: now + 4 * HOUR },
    now,
    now + 4 * HOUR
  );
  assert.equal(next.duplicate, true);
  assert.equal(next.step, 0);
  assert.equal(next.pauseMs, 4 * HOUR);
});

test("two parallel check-quota 429s park the connection once, for 5h", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "AG Parallel 429",
  });
  const connId = (conn as { id: string }).id;
  const [first, second] = await Promise.all([
    pause.applyCheckQuotaPause(connId),
    pause.applyCheckQuotaPause(connId),
  ]);
  const pauses = [first, second].sort((a, b) => Number(a.duplicate) - Number(b.duplicate));
  assert.equal(pauses[0].duplicate, false);
  assert.equal(pauses[0].step, 0);
  assert.equal(pauses[0].pauseMs, 5 * HOUR);
  assert.equal(pauses[1].duplicate, true);
  assert.equal(pauses[1].step, 0);

  const stored = (await providersDb.getProviderConnectionById(connId)) as {
    providerSpecificData?: { checkQuota429Ladder?: { step?: number; untilMs?: number } };
  } | null;
  assert.equal(stored?.providerSpecificData?.checkQuota429Ladder?.step, 0);
  const until = Number(stored?.providerSpecificData?.checkQuota429Ladder?.untilMs);
  assert.ok(Math.abs(until - (Date.now() + 5 * HOUR)) < 60_000);
});

test("a 429 in the hour after a 5h pause becomes 10h", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "AG Climb 429",
  });
  const connId = (conn as { id: string }).id;
  const past = Date.now() - 30 * 60 * 1000;
  await providersDb.updateProviderConnection(connId, {
    providerSpecificData: { checkQuota429Ladder: { step: 0, untilMs: past } },
  });
  providersDb.clearConnectionRateLimit(connId);

  const applied = await pause.applyCheckQuotaPause(connId);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.step, 1);
  assert.equal(applied.pauseMs, 10 * HOUR);
  assert.equal(providersDb.isConnectionRateLimited(connId), true);
});
