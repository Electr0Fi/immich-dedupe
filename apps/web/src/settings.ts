export type SafetyConfig = {
  dryRunByDefault: boolean;
  requireConfirmation: boolean;
  preferTrash: boolean;
  blockPermanentDelete: boolean;
  warnFavorites: boolean;
  warnMultipleAlbums: boolean;
};

export type PerformanceConfig = {
  batchSize: number;
  concurrentRequests: number;
  requestDelayMs: number;
  cacheEnabled: boolean;
};

export const DEFAULT_SAFETY: SafetyConfig = {
  dryRunByDefault: true,
  requireConfirmation: true,
  preferTrash: true,
  blockPermanentDelete: true,
  warnFavorites: true,
  warnMultipleAlbums: true,
};

export const DEFAULT_PERFORMANCE: PerformanceConfig = {
  batchSize: 50,
  concurrentRequests: 3,
  requestDelayMs: 200,
  cacheEnabled: true,
};

