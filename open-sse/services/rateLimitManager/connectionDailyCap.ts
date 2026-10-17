/**
 * Per-connection requests-per-day gate.
 *
 * `rpd` is stored on the connection but is not a Bottleneck setting: that
 * limiter has one reservoir, already used for the per-minute cap. This counter
 * is a separate fixed UTC-day window, keyed by connection id, so two quota
 * families on the same account share one daily budget.
 *
 * Redis keeps the count across a container restart. Unit tests and a missing
 * Redis stay on the in-memory store. A Redis error falls back to that store
 * instead of letting the request through.
 */

import { getRedisClient, isRedisConfigured } from "@/shared/utils/rateLimiter";

export const CONNECTION_RPD_WINDOW_SECONDS = 86_400;

export interface ConnectionDailyDecision {
  allowed: boolean;
  limit: number;
  count: number;
  resetAtMs: number;
}

const memoryCounts = new Map<string, number>();

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
