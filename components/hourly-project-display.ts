/** Keep the live display on whole server seconds and within the original timer limit. */
export function liveProjectSeconds(totalSeconds: number, capMinutes: number, running: { durationSeconds: number; timerLimitSeconds: number } | null, elapsedMillis: number) {
  if (!running) return totalSeconds;
  const extra = Math.floor(Math.min(
    Math.max(0, elapsedMillis / 1000),
    Math.max(0, running.timerLimitSeconds - running.durationSeconds),
    Math.max(0, capMinutes * 60 - totalSeconds),
  ));
  return totalSeconds + extra;
}
