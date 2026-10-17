import {
  getProviderConnectionById,
  setConnectionRateLimitUntil,
  updateProviderConnection,
} from "@/lib/db/providers";

/** 5h, then 10h, then 24h, then 7d. The last step repeats. */
export const CHECK_QUOTA_PAUSE_STEPS_MS = [
  5 * 60 * 60 * 1000,
  10 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
] as const;

/** A 429 inside this window after the pause ends climbs one step. */
export const CHECK_QUOTA_GRACE_MS = 60 * 60 * 1000;

export const CHECK_QUOTA_LADDER_KEY = "checkQuota429Ladder";

export interface CheckQuotaLadder {
  step: number;
  untilMs: number;
}

export interface CheckQuotaPause {
  step: number;
  pauseMs: number;
  duplicate: boolean;
}

const tails = new Map<string, Promise<unknown>>();

function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(connectionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(connectionId, settled);
  void settled.then(() => {
    if (tails.get(connectionId) === settled) tails.delete(connectionId);
  });
  return run;
}

function untilMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readCheckQuotaLadder(value: unknown): CheckQuotaLadder | null {
  const record = asRecord(value);
  const step = record.step;
  const until = untilMs(record.untilMs);
  if (typeof step !== "number" || !Number.isInteger(step) || step < 0) return null;
  if (!Number.isFinite(until)) return null;
  return {
    step: Math.min(step, CHECK_QUOTA_PAUSE_STEPS_MS.length - 1),
    untilMs: until,
  };
}

/**
 * Next pause for one check-quota 429.
 * A pause that is still running is the same incident: parallel requests must
 * not climb. A 429 more than an hour after the pause ended starts again at 5h.
 */
export function nextCheckQuotaPause(
  previous: CheckQuotaLadder | null,
  nowMs: number,
  activeUntilMs: number | null
): CheckQuotaPause {
  if (activeUntilMs != null && activeUntilMs > nowMs) {
    return {
      step: previous?.step ?? 0,
      pauseMs: activeUntilMs - nowMs,
      duplicate: true,
    };
  }
  const withinGrace =
    previous != null && nowMs >= previous.untilMs && nowMs - previous.untilMs <= CHECK_QUOTA_GRACE_MS;
  const step = withinGrace
    ? Math.min(previous.step + 1, CHECK_QUOTA_PAUSE_STEPS_MS.length - 1)
    : 0;
  return { step, pauseMs: CHECK_QUOTA_PAUSE_STEPS_MS[step], duplicate: false };
}

export async function applyCheckQuotaPause(
  connectionId: string,
  nowMs = Date.now()
): Promise<CheckQuotaPause> {
  return withConnectionLock(connectionId, async () => {
    const conn = (await getProviderConnectionById(connectionId)) as {
      rateLimitedUntil?: unknown;
      providerSpecificData?: unknown;
    } | null;
    const psd = asRecord(conn?.providerSpecificData);
    const previous = readCheckQuotaLadder(psd[CHECK_QUOTA_LADDER_KEY]);
    const columnUntil = untilMs(conn?.rateLimitedUntil);
    const activeUntilMs = Number.isFinite(columnUntil) && columnUntil > nowMs ? columnUntil : null;
    const decision = nextCheckQuotaPause(previous, nowMs, activeUntilMs);
    if (decision.duplicate) return decision;

    const until = nowMs + decision.pauseMs;
    setConnectionRateLimitUntil(connectionId, until);
    await updateProviderConnection(connectionId, {
      providerSpecificData: {
        ...psd,
        [CHECK_QUOTA_LADDER_KEY]: { step: decision.step, untilMs: until },
      },
    });
    return decision;
  });
}
