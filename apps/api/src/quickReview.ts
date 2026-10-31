import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QuickReview, QuickReviewCandidate, QuickReviewExclusion, ReviewedCandidate, RuleSet, ConfiguredDecision } from '@immich-dedupe/shared';
import { canonicalRulesJson, evaluateDuplicateGroup, evaluateConfiguredGroup } from '@immich-dedupe/rule-engine';
import { normalizeDuplicates } from './normalizeDuplicates';
import { PLAN_CAPACITY, PLAN_TTL_MS, projectAsset, reviewedAssetSchema } from './reviewedPlan';

const text = z.string().nullable().optional().catch(null);
const number = z.number().nullable().optional().catch(null);
const flag = z.boolean().nullable().optional().catch(null);
// Keep only fields needed by the existing rules and later snapshot comparison.
export const quickGroupListSchema = z.array(z.object({
  duplicateId: z.string().min(1),
  assets: z.array(z.object({
    id: z.string().min(1), duplicateId: text, originalFileName: text, originalPath: text,
    checksum: text, type: text, width: number, height: number,
    isEdited: flag, isTrashed: flag, isFavorite: flag, isArchived: flag, isOffline: flag,
    livePhotoVideoId: z.string().nullable().optional().catch(undefined),
    exifInfo: z.object({
      fileSizeInByte: z.union([z.number(), z.string()]).nullish().catch(null),
      exifImageWidth: number, exifImageHeight: number,
    }).passthrough().nullish().catch(null),
  }).passthrough()),
}));
const quickAssetSchema = reviewedAssetSchema.omit({ albums: true }).strip();
export function quickCandidate(candidate: ReviewedCandidate): QuickReviewCandidate {
  return { groupId: candidate.groupId, keepAsset: quickAssetSchema.parse(candidate.keepAsset),
    trashAsset: quickAssetSchema.parse(candidate.trashAsset), decision: candidate.decision,
    ...(candidate.ruleset ? { ruleset: candidate.ruleset, ruleAssets: candidate.ruleAssets?.map((asset) => ({ ...asset, albums: [], albumsKnown: false })) } : {}) };
}
export function evaluateQuickGroup(raw: z.infer<typeof quickGroupListSchema>[number], ruleset?: RuleSet): QuickReviewCandidate | QuickReviewExclusion {
  const exclude = (message: string, reason: 'ineligible' | 'unverified' = 'ineligible'): QuickReviewExclusion => ({ groupId: raw.duplicateId, reason, message, attemptIds: [] });
  if (raw.assets.length !== 2) return exclude(`${raw.assets.length} ${raw.assets.length === 1 ? 'asset' : 'assets'} in group; current rule definitions only support exactly 2 assets per group.`);
  if (new Set(raw.assets.map((asset) => asset.id)).size !== 2) return exclude('The group contains repeated asset IDs; 2 distinct assets are required.');
  const group = normalizeDuplicates([raw]).groups[0];
  const missing = new Set<string>();
  for (const [index, asset] of group.assets.entries()) {
    const original = raw.assets[index];
    const size = original.exifInfo?.fileSizeInByte;
    const parsed = typeof size === 'number' || (typeof size === 'string' && size.trim()) ? Number(size) : NaN;
    asset.fileSize = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    if (original.duplicateId == null) missing.add('asset group association');
    else if (original.duplicateId !== raw.duplicateId) return exclude('An asset belongs to a different duplicate group; its membership could not be verified.');
    if (!asset.fileName.trim()) missing.add('filename');
    if (!asset.originalPath) missing.add('source path');
    if (!(asset.width != null && asset.width > 0 && asset.height != null && asset.height > 0)) missing.add('dimensions');
    if (asset.fileSize === null) missing.add('file size');
    if ([asset.isEdited, asset.isTrashed, asset.isFavorite, asset.isArchived, asset.isOffline].some((value) => value === null)) missing.add('safety flags');
    if (original.type == null) missing.add('media type');
    if (original.livePhotoVideoId === undefined) missing.add('Live Photo linkage');
  }
  if (missing.size) return exclude(`Not verified in Quick Review: missing or invalid ${[...missing].join(', ')} in the duplicate response. Extra metadata reads were skipped.`, 'unverified');
  const decision = ruleset ? evaluateConfiguredGroup(group, ruleset) : evaluateDuplicateGroup(group);
  const configured = ruleset ? decision as ConfiguredDecision : null;
  if (decision.status !== 'auto-resolve' || decision.confidence !== 100 || !decision.keepAssetId || decision.trashAssetIds.length !== 1) return { ...exclude(decision.reasons.join('; '), 'outcome' in decision && decision.outcome === 'deferred' ? 'unverified' : 'ineligible'), ...(configured?.resolution ? { resolution: configured.resolution, ruleName: decision.matchedRuleName } : {}) };
  const keep = group.assets.find((asset) => asset.id === decision.keepAssetId)!;
  const trash = group.assets.find((asset) => asset.id === decision.trashAssetIds[0])!;
  return { groupId: group.groupId, keepAsset: quickAssetSchema.parse(projectAsset(keep)), trashAsset: quickAssetSchema.parse(projectAsset(trash)), decision,
    ...(ruleset ? { ruleset, ruleAssets: [keep, trash] } : {}) };
}
export function changedQuickCandidate(expected: QuickReviewCandidate, fresh: ReviewedCandidate): string[] {
  const actual = quickCandidate(fresh);
  const reasons: string[] = [];
  for (const side of ['keepAsset', 'trashAsset'] as const) {
    const before = expected[side], after = { ...actual[side] };
    // A checksum absent from the duplicate response was never claimed as reviewed.
    if (before.checksum === null) after.checksum = null;
    if (canonicalRulesJson(before) !== canonicalRulesJson(after)) reasons.push(`${side === 'keepAsset' ? 'Keeper' : 'Loser'} metadata or selection changed since Quick Review`);
  }
  if (expected.ruleset) {
    if (expected.ruleset.revision !== fresh.ruleset?.revision || expected.decision.matchedRuleId !== actual.decision.matchedRuleId ||
        expected.decision.keepAssetId !== actual.decision.keepAssetId || JSON.stringify(expected.decision.trashAssetIds) !== JSON.stringify(actual.decision.trashAssetIds)) reasons.push('Rule decision changed since Quick Review');
    for (const before of expected.ruleAssets ?? []) {
      const after = fresh.ruleAssets?.find((asset) => asset.id === before.id);
      if (!after) { reasons.push('Rule inputs changed since Quick Review'); continue; }
      const side = before.id === expected.keepAsset.id ? 'Keeper' : 'Loser';
      const { albums: _albums, albumsKnown: _known, ruleMetadata, ...input } = before;
      const { albums: _freshAlbums, albumsKnown: _freshKnown, ruleMetadata: freshMetadata, ...freshInput } = after;
      // Quick Review only attested to values present in the duplicate response.
      // New details may fill unknowns; fresh rule evaluation must still select
      // the same rule and keeper. Previously observed values may not change.
      for (const [field, value] of Object.entries(input)) {
        if (value != null && canonicalRulesJson(value) !== canonicalRulesJson(freshInput[field as keyof typeof freshInput])) {
          reasons.push(`${side} rule input "${field}" changed since Quick Review`);
        }
      }
      for (const [field, value] of Object.entries(ruleMetadata ?? {})) {
        if (value != null && canonicalRulesJson(value) !== canonicalRulesJson(freshMetadata?.[field])) {
          reasons.push(`${side} rule input "exif.${field}" changed since Quick Review`);
        }
      }
    }
  } else if (JSON.stringify(expected.decision) !== JSON.stringify(actual.decision)) reasons.push('Rule decision changed since Quick Review');
  return reasons;
}
export function createQuickReviewStore(now: () => number) {
  const reviews = new Map<string, QuickReview>();
  function purge() { for (const [id, review] of reviews) if (Date.parse(review.expiresAt) <= now()) reviews.delete(id); }
  return {
    put(input: Omit<QuickReview, 'reviewId' | 'createdAt' | 'expiresAt'>) {
      purge();
      while (reviews.size >= PLAN_CAPACITY) reviews.delete(reviews.keys().next().value!);
      const created = now();
      const review: QuickReview = { ...structuredClone(input), reviewId: randomUUID(), createdAt: new Date(created).toISOString(), expiresAt: new Date(created + PLAN_TTL_MS).toISOString() };
      reviews.set(review.reviewId, review);
      return structuredClone(review);
    },
    get(id: string) { purge(); return reviews.get(id); },
  };
}
