/**
 * Compact, session-only data returned by a normal local scan. These values are
 * deliberately display/planning metadata: no audio, path, fingerprint,
 * recognition signature, or provider payload belongs here.
 */
export type TargetedRange = {
  startSeconds: number;
  endSeconds: number;
};

export type AcousticActivityRegion = TargetedRange & {
  activityLevel: number;
};

export type RuntimeSoundtrackMap = {
  available: boolean;
  activityRegions: AcousticActivityRegion[];
  recommendedRanges: TargetedRange[];
};

export function clampTimelinePercent(seconds: number, durationSeconds: number) {
  if (!Number.isFinite(seconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, seconds / durationSeconds * 100));
}

/**
 * Moment Finder accepts an intentional 8–28 second request. A map segment can
 * be shorter or much longer, so center a valid inspection range around it.
 */
export function normalizeMomentSelection(range: TargetedRange, durationSeconds: number): TargetedRange | null {
  if (
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 8
  ) {
    return null;
  }

  const sourceDuration = Math.max(durationSeconds, 0);
  const desiredLength = Math.min(
    28,
    sourceDuration,
    Math.max(8, range.endSeconds - range.startSeconds),
  );
  const center = Math.min(
    sourceDuration,
    Math.max(0, (range.startSeconds + range.endSeconds) / 2),
  );
  const startSeconds = Math.min(
    Math.max(0, center - desiredLength / 2),
    sourceDuration - desiredLength,
  );

  return {
    startSeconds,
    endSeconds: startSeconds + desiredLength,
  };
}

export function timeRangeStyle(range: TargetedRange, durationSeconds: number) {
  const start = clampTimelinePercent(range.startSeconds, durationSeconds);
  const end = clampTimelinePercent(range.endSeconds, durationSeconds);
  return {
    left: `${Math.min(start, end)}%`,
    width: `${Math.max(end - start, 0.7)}%`,
  };
}
