/**
 * Per-connection requests-per-day and requests-per-week gates.
 *
 * `rpd` and `rpw` are stored on the connection but are not Bottleneck
 * settings: that limiter has one reservoir, already used for the per-minute
 * cap. The day counter is a fixed UTC-day window. The week counter starts at
 * that account's first counted request and lasts 7 days, then the next 7.
 * Both are keyed by connection id, so every model on one account shares one
 * budget. A request increments both, or neither: a weekly reject does not
 * consume a daily slot. The first-request time is stored on the connection.
 * The counts stay in Redis.
 *
 * Redis keeps the counts across a container restart. Unit tests and a missing
 * Redis stay on the in-memory store. A Redis error falls back to that store
 * instead of letting the request through.
 */

import { getRedisClient, isRedisConfigured } from "@/shared/utils/rateLimiter";

export const CONNECTION_RPD_WINDOW_SECONDS = 86_400;
export const CONNECTION_RPW_WINDOW_SECONDS = 604_800;

export type ConnectionCapPeriod = "day" | "week";

export interface ConnectionCapDecision {
  allowed: boolean;
  period: ConnectionCapPeriod;
  limit: number;
  count: number;
  resetAtMs: number;
}

export interface ConnectionDailyDecision {
  allowed: boolean;
  limit: number;
  count: number;
  resetAtMs: number;
}

const memoryCounts = new Map<string, number>();
const memoryWeekCounts = new Map<string, number>();
const weekAnchors = new Map<string, number>();
const anchorWrites = new Map<string, Promise<number>>();

const RESERVE_SCRIPT = `
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
if count >= limit then
  return {0, count}
end
local next = redis.call("INCR", KEYS[1])
if next == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return {1, next}
`;

export function resetConnectionDailyCapForTests(): void {
  memoryCounts.clear();
  memoryWeekCounts.clear();
  weekAnchors.clear();
  anchorWrites.clear();
}

/** Seven-day window that starts at this account's first counted request. */
export function connectionPersonalWeek(
  anchorMs: number,
  nowMs: number
): { startMs: number; resetAtMs: number } {
  const span = CONNECTION_RPW_WINDOW_SECONDS * 1000;
  const elapsed = nowMs - anchorMs;
  const index = elapsed >= 0 ? Math.floor(elapsed / span) : 0;
  const startMs = anchorMs + index * span;
  return { startMs, resetAtMs: startMs + span };
}

function weekRedisKey(connectionId: string, windowStartMs: number): string {
  return `rl:conn:${connectionId}:rpw:${Math.floor(windowStartMs / 1000)}`;
}

export function loadConnectionWeekAnchors(connections: Array<Record<string, unknown>>): void {
  weekAnchors.clear();
  for (const connection of connections) {
    const id = typeof connection.id === "string" ? connection.id : "";
    const raw = connection.firstRequestAt;
    const anchorMs = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (id && Number.isFinite(anchorMs)) weekAnchors.set(id, anchorMs);
  }
}

export function getConnectionWeekAnchor(connectionId: string): number | null {
  return weekAnchors.get(connectionId) ?? null;
}

/**
 * Return the account's week start. The first counted request stamps `nowMs`
 * and persists it. A stored value always wins over a later stamp.
 */
export async function ensureConnectionWeekAnchor(
  connectionId: string,
  nowMs: number,
  persist: (id: string, atMs: number) => Promise<number | null>
): Promise<number> {
  const known = weekAnchors.get(connectionId);
  if (known !== undefined) return known;
  const pending = anchorWrites.get(connectionId);
  if (pending) return pending;
  const job = (async () => {
    const stored = await persist(connectionId, nowMs);
    const anchor = stored ?? nowMs;
    weekAnchors.set(connectionId, anchor);
    return anchor;
  })();
  anchorWrites.set(connectionId, job);
  try {
    return await job;
  } finally {
    anchorWrites.delete(connectionId);
  }
}

function positiveLimit(limit: number | undefined): number {
  return typeof limit === "number" && limit > 0 ? limit : 0;
}

function windowNumber(nowMs: number): number {
  return Math.floor(nowMs / 1000 / CONNECTION_RPD_WINDOW_SECONDS);
}

function windowResetAtMs(window: number): number {
  return (window + 1) * CONNECTION_RPD_WINDOW_SECONDS * 1000;
}

function useMemoryStore(): boolean {
  return typeof process.env.NODE_TEST_CONTEXT === "string" || !isRedisConfigured();
}

function reserveInMemory(
  connectionId: string,
  limit: number,
  nowMs: number
): ConnectionDailyDecision {
  const window = windowNumber(nowMs);
  const key = `${connectionId}:${window}`;
  if (memoryCounts.size > 200) {
    const suffix = `:${window}`;
    for (const stored of memoryCounts.keys()) {
      if (!stored.endsWith(suffix)) memoryCounts.delete(stored);
    }
  }
  const count = memoryCounts.get(key) ?? 0;
  const resetAtMs = windowResetAtMs(window);
  if (count >= limit) return { allowed: false, limit, count, resetAtMs };
  memoryCounts.set(key, count + 1);
  return { allowed: true, limit, count: count + 1, resetAtMs };
}

function redisKey(connectionId: string, window: number): string {
  return `rl:conn:${connectionId}:${CONNECTION_RPD_WINDOW_SECONDS}:${window}`;
}

/**
 * Current count for the UTC day, without reserving a request. Missing keys
 * are zero. A Redis error returns an empty map so the caller can omit the
 * number instead of showing a stale zero.
 */
export async function readConnectionDailyCounts(
  connectionIds: string[],
  nowMs = Date.now()
): Promise<Record<string, number>> {
  const ids = connectionIds.filter((id) => typeof id === "string" && id.length > 0);
  const window = windowNumber(nowMs);
  if (ids.length === 0) return {};
  if (useMemoryStore()) {
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = memoryCounts.get(`${id}:${window}`) ?? 0;
    return counts;
  }
  try {
    const redis = await getRedisClient();
    const values = (await redis.mget(...ids.map((id) => redisKey(id, window)))) as Array<
      string | null
    >;
    const counts: Record<string, number> = {};
    ids.forEach((id, index) => {
      const parsed = Number(values[index] ?? 0);
      counts[id] = Number.isFinite(parsed) ? parsed : 0;
    });
    return counts;
  } catch (error) {
    console.error(
      "[RATE-LIMIT] connection daily cap read failed:",
      error instanceof Error ? error.message : error
    );
    return {};
  }
}

export async function reserveConnectionDailyRequest(
  connectionId: string,
  limit: number,
  nowMs = Date.now()
): Promise<ConnectionDailyDecision> {
  const resetAtMs = windowResetAtMs(windowNumber(nowMs));
  if (!connectionId || !(typeof limit === "number" && limit > 0)) {
    return { allowed: true, limit: 0, count: 0, resetAtMs };
  }
  if (useMemoryStore()) return reserveInMemory(connectionId, limit, nowMs);

  const window = windowNumber(nowMs);
  try {
    const redis = await getRedisClient();
    const result = (await redis.eval(
      RESERVE_SCRIPT,
      1,
      redisKey(connectionId, window),
      String(limit),
      String(CONNECTION_RPD_WINDOW_SECONDS * 2)
    )) as [number, number];
    return {
      allowed: Number(result[0]) === 1,
      limit,
      count: Number(result[1]),
      resetAtMs: windowResetAtMs(window),
    };
  } catch (error) {
    console.error(
      "[RATE-LIMIT] connection daily cap redis failed, using in-memory counter:",
      error instanceof Error ? error.message : error
    );
    return reserveInMemory(connectionId, limit, nowMs);
  }
}

/**
 * Executor-shaped 429. The body says "daily quota" so the existing account
 * fallback parks an OAuth connection until the next day and the combo moves
 * to another account. No upstream call is made.
 */
export function connectionDailyCapResult(decision: ConnectionDailyDecision): {
  response: Response;
} {
  const retryAfterSec = Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000));
  return {
    response: new Response(
      JSON.stringify({
        error: {
          message: `OmniRoute connection daily quota exhausted (${decision.count}/${decision.limit}). Try again tomorrow.`,
          type: "connection_daily_quota",
          code: "CONNECTION_RPD_EXHAUSTED",
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSec),
        },
      }
    ),
  };
}

const RESERVE_CAPS_SCRIPT = `
local dailyLimit = tonumber(ARGV[1])
local weeklyLimit = tonumber(ARGV[2])
local dailyTtl = tonumber(ARGV[3])
local weeklyTtl = tonumber(ARGV[4])
local dailyCount = 0
local weeklyCount = 0
if dailyLimit > 0 then
  dailyCount = tonumber(redis.call("GET", KEYS[1]) or "0")
  if dailyCount >= dailyLimit then
    return {0, dailyCount, "day"}
  end
end
if weeklyLimit > 0 then
  weeklyCount = tonumber(redis.call("GET", KEYS[2]) or "0")
  if weeklyCount >= weeklyLimit then
    return {0, weeklyCount, "week"}
  end
end
if dailyLimit > 0 then
  dailyCount = redis.call("INCR", KEYS[1])
  if dailyCount == 1 then
    redis.call("EXPIRE", KEYS[1], dailyTtl)
  end
end
if weeklyLimit > 0 then
  weeklyCount = redis.call("INCR", KEYS[2])
  if weeklyCount == 1 then
    redis.call("EXPIRE", KEYS[2], weeklyTtl)
  end
end
if dailyLimit > 0 then
  return {1, dailyCount, "day"}
end
return {1, weeklyCount, "week"}
`;

function reserveCapsInMemory(
  connectionId: string,
  rpd: number,
  rpw: number,
  weekAnchorMs: number | null,
  nowMs: number
): ConnectionCapDecision {
  const dayWindow = windowNumber(nowMs);
  const week = weekAnchorMs === null ? null : connectionPersonalWeek(weekAnchorMs, nowMs);
  const dayKey = `${connectionId}:${dayWindow}`;
  const weekKey = week === null ? "" : `${connectionId}:${week.startMs}`;
  if (week && memoryWeekCounts.size > 200) {
    const suffix = `:${week.startMs}`;
    for (const stored of memoryWeekCounts.keys()) {
      if (!stored.endsWith(suffix)) memoryWeekCounts.delete(stored);
    }
  }
  const dayCount = rpd > 0 ? (memoryCounts.get(dayKey) ?? 0) : 0;
  const weekCount = rpw > 0 && week ? (memoryWeekCounts.get(weekKey) ?? 0) : 0;
  if (rpd > 0 && dayCount >= rpd) {
    return {
      allowed: false,
      period: "day",
      limit: rpd,
      count: dayCount,
      resetAtMs: windowResetAtMs(dayWindow),
    };
  }
  if (rpw > 0 && week && weekCount >= rpw) {
    return {
      allowed: false,
      period: "week",
      limit: rpw,
      count: weekCount,
      resetAtMs: week.resetAtMs,
    };
  }
  if (rpd > 0) memoryCounts.set(dayKey, dayCount + 1);
  if (rpw > 0 && week) memoryWeekCounts.set(weekKey, weekCount + 1);
  if (rpd > 0) {
    return {
      allowed: true,
      period: "day",
      limit: rpd,
      count: dayCount + 1,
      resetAtMs: windowResetAtMs(dayWindow),
    };
  }
  return {
    allowed: true,
    period: "week",
    limit: rpw,
    count: week ? weekCount + 1 : 0,
    resetAtMs: week ? week.resetAtMs : windowResetAtMs(dayWindow),
  };
}

export interface ConnectionWeekAnchor {
  id: string;
  anchorMs: number | null;
}

/** Current personal-week count, without reserving a request. No anchor means 0. */
export async function readConnectionWeeklyCounts(
  entries: ConnectionWeekAnchor[],
  nowMs = Date.now()
): Promise<Record<string, number>> {
  const rows = entries.filter((entry) => entry.id);
  if (rows.length === 0) return {};
  if (useMemoryStore()) {
    const counts: Record<string, number> = {};
    for (const entry of rows) {
      if (entry.anchorMs === null) {
        counts[entry.id] = 0;
        continue;
      }
      const week = connectionPersonalWeek(entry.anchorMs, nowMs);
      counts[entry.id] = memoryWeekCounts.get(`${entry.id}:${week.startMs}`) ?? 0;
    }
    return counts;
  }
  try {
    const redis = await getRedisClient();
    const keys = rows.map((entry) =>
      entry.anchorMs === null ? "" : weekRedisKey(entry.id, connectionPersonalWeek(entry.anchorMs, nowMs).startMs)
    );
    const present = keys.filter((key) => key.length > 0);
    const values = present.length
      ? ((await redis.mget(...present)) as Array<string | null>)
      : [];
    let cursor = 0;
    const counts: Record<string, number> = {};
    rows.forEach((entry, index) => {
      if (!keys[index]) {
        counts[entry.id] = 0;
        return;
      }
      const parsed = Number(values[cursor] ?? 0);
      cursor += 1;
      counts[entry.id] = Number.isFinite(parsed) ? parsed : 0;
    });
    return counts;
  } catch (error) {
    console.error(
      "[RATE-LIMIT] connection weekly cap read failed:",
      error instanceof Error ? error.message : error
    );
    return {};
  }
}

/**
 * Reserve one request against the daily cap, the weekly cap, or both.
 * A reject leaves both counters unchanged.
 */
export async function reserveConnectionRequestCaps(
  connectionId: string,
  limits: { rpd?: number; rpw?: number; weekAnchorMs?: number | null },
  nowMs = Date.now()
): Promise<ConnectionCapDecision> {
  const rpd = positiveLimit(limits.rpd);
  const weekAnchorMs =
    typeof limits.weekAnchorMs === "number" && Number.isFinite(limits.weekAnchorMs)
      ? limits.weekAnchorMs
      : null;
  const rpw = positiveLimit(limits.rpw) > 0 && weekAnchorMs !== null ? positiveLimit(limits.rpw) : 0;
  const dayReset = windowResetAtMs(windowNumber(nowMs));
  if (!connectionId || (rpd === 0 && rpw === 0)) {
    return { allowed: true, period: "day", limit: 0, count: 0, resetAtMs: dayReset };
  }
  if (useMemoryStore()) return reserveCapsInMemory(connectionId, rpd, rpw, weekAnchorMs, nowMs);

  const dayWindow = windowNumber(nowMs);
  const week = connectionPersonalWeek(weekAnchorMs as number, nowMs);
  try {
    const redis = await getRedisClient();
    const result = (await redis.eval(
      RESERVE_CAPS_SCRIPT,
      2,
      redisKey(connectionId, dayWindow),
      weekRedisKey(connectionId, week.startMs),
      String(rpd),
      String(rpw),
      String(CONNECTION_RPD_WINDOW_SECONDS * 2),
      String(CONNECTION_RPW_WINDOW_SECONDS * 2)
    )) as [number, number, string];
    const period: ConnectionCapPeriod = result[2] === "week" ? "week" : "day";
    return {
      allowed: Number(result[0]) === 1,
      period,
      limit: period === "week" ? rpw : rpd,
      count: Number(result[1]),
      resetAtMs: period === "week" ? week.resetAtMs : windowResetAtMs(dayWindow),
    };
  } catch (error) {
    console.error(
      "[RATE-LIMIT] connection cap redis failed, using in-memory counter:",
      error instanceof Error ? error.message : error
    );
    return reserveCapsInMemory(connectionId, rpd, rpw, weekAnchorMs, nowMs);
  }
}

/**
 * Executor-shaped 429. The body says "weekly quota" so account fallback parks
 * the connection the same way as a daily cap and the combo moves on. No
 * upstream call is made.
 */
export function connectionWeeklyCapResult(decision: {
  limit: number;
  count: number;
  resetAtMs: number;
}): {
  response: Response;
} {
  const retryAfterSec = Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000));
  return {
    response: new Response(
      JSON.stringify({
        error: {
          message: `OmniRoute connection weekly quota exhausted (${decision.count}/${decision.limit}). Try again next week.`,
          type: "connection_weekly_quota",
          code: "CONNECTION_RPW_EXHAUSTED",
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfterSec),
        },
      }
    ),
  };
}
