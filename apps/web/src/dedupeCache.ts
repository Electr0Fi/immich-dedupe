import type { DuplicateAnalysisResponse, ExecutionPlanResponse, ExecutionStatusResponse } from './api';

export type DedupeSnapshot = {
  status: ExecutionStatusResponse;
  plan: ExecutionPlanResponse;
  analysis: DuplicateAnalysisResponse;
};

// Preserve the existing cache across screen changes. Scan-keyed caching is a later milestone.
let snapshot: DedupeSnapshot | null = null;
let generation = 0;

export function getDedupeCache() { return snapshot; }
export function getDedupeCacheGeneration() { return generation; }
export function setDedupeCache(value: DedupeSnapshot, expectedGeneration: number) {
  if (generation === expectedGeneration) snapshot = value;
}
export function clearDedupeCache() {
  snapshot = null;
  generation++;
}
