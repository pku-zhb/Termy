export interface CodexRateLimitWindows {
  fiveHour: Record<string, unknown> | null;
  weekly: Record<string, unknown> | null;
}

const ONE_DAY_MINUTES = 24 * 60;

export function classifyCodexRateLimitWindows(
  rateLimits: Record<string, unknown>,
): CodexRateLimitWindows {
  const primary = recordValue(rateLimits.primary);
  const secondary = recordValue(rateLimits.secondary);
  const windows = [primary, secondary].filter((window): window is Record<string, unknown> => window !== null);
  const hasDurationMetadata = windows.some((window) => windowDurationMinutes(window) !== null);

  if (!hasDurationMetadata) {
    return { fiveHour: primary, weekly: secondary };
  }

  return {
    fiveHour: windows.find((window) => {
      const duration = windowDurationMinutes(window);
      return duration !== null && duration <= ONE_DAY_MINUTES;
    }) ?? null,
    weekly: windows.find((window) => {
      const duration = windowDurationMinutes(window);
      return duration !== null && duration > ONE_DAY_MINUTES;
    }) ?? null,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function windowDurationMinutes(window: Record<string, unknown>): number | null {
  const value = window.windowDurationMins;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
