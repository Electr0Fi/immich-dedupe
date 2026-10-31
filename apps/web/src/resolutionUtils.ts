import type { ResolutionCondition, ResolutionAssessment } from '@immich-dedupe/shared';
export const newRequirement = (): ResolutionCondition => ({ field: 'fileSize', operator: 'gt', compareTo: 'other' });
export function hasStrictByteComparison(value: ResolutionCondition): boolean {
  if ('all' in value) return value.all.some(hasStrictByteComparison);
  if ('any' in value) return value.any.some(hasStrictByteComparison);
  return 'field' in value && value.field === 'fileSize' && value.compareTo === 'other' && ['gt','lt'].includes(value.operator);
}
export function isResolutionConflict(assessment?: ResolutionAssessment) { return assessment?.status === 'no-match' || assessment?.status === 'ambiguous'; }
