/** Automatic compaction policy for the QQ distribution's agent runtimes. */
export const AUTO_COMPACT_PERCENT = 70;

export function compactionReserveTokens(contextWindow: number): number | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined;
  return contextWindow - Math.floor(contextWindow * AUTO_COMPACT_PERCENT / 100);
}
