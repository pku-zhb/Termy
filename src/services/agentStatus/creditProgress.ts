export function resetElapsedPercent(
  resetAtMs: number | null,
  windowMs: number | null,
  nowMs = Date.now(),
): number | null {
  if (!resetAtMs || !windowMs || windowMs <= 0) {
    return null;
  }

  const remainingMs = resetAtMs - nowMs;
  if (remainingMs <= 0) {
    return 0;
  }

  return clampMeterPercent(((windowMs - remainingMs) / windowMs) * 100);
}

function clampMeterPercent(value: number): number {
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped * 1000) / 1000;
}
