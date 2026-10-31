import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { evaluateDuplicateGroup, evaluateConfiguredGroup, validateRuleSet } from "@immich-dedupe/rule-engine";
import type { AssetRecord, DuplicateGroup, ReviewedAsset, ReviewedCandidate, ReviewedPlan, RuleSet } from "@immich-dedupe/shared";
import type { FreshPreflight } from "./freshPreflight";

const id = z.string().min(1);
const ids = z.array(id).refine((items) => new Set(items).size === items.length, "Duplicate IDs");
const albums = z.array(z.object({ albumId: id, albumName: z.string() }).strict()).refine((items) => new Set(items.map((a) => a.albumId)).size === items.length, "Duplicate albums");
export const reviewedAssetSchema = z.object({
  id, duplicateId: id, fileName: id, originalPath: id, checksum: z.string().nullable(), assetType: z.literal("IMAGE"),
  width: z.number().positive(), height: z.number().positive(), fileSize: z.number().positive(),
  isEdited: z.literal(false), isTrashed: z.literal(false), isFavorite: z.literal(false), isArchived: z.literal(false), isOffline: z.literal(false),
  livePhotoVideoId: z.null(), isExternal: z.boolean(), isInternal: z.boolean(), albums,
}).strict();
export const reviewedCandidateSchema = z.object({
  groupId: id, keepAsset: reviewedAssetSchema, trashAsset: reviewedAssetSchema,
  decision: z.object({ groupId: id, status: z.literal("auto-resolve"), keepAssetId: id, trashAssetIds: z.array(id).length(1),
    confidence: z.literal(100), matchedRuleId: id.nullable(), matchedRuleName: id.nullable(), reasons: z.array(z.string()) }).strict(),
  requiredAlbumIds: ids, proposedAlbumIds: ids, skippedAlbumIds: ids,
}).strict().superRefine((candidate, context) => {
  try {
    const expected = candidateFromGroup(candidateToGroup(candidate), evaluateDuplicateGroup(candidateToGroup(candidate)));
    if (JSON.stringify(candidate) !== JSON.stringify(expected)) throw new Error("Invalid candidate");
  } catch { context.addIssue({ code: "custom", message: "Inconsistent reviewed selection, rule or album actions" }); }
});
// The historical schema above deliberately retains its original rule semantics.
// Configured evidence includes the complete rule inputs, rather than reconstructing
// dates, MIME or EXIF fields from the compact display assets.
const ruleAssetSchema = reviewedAssetSchema.extend({
  originalMimeType: z.string().nullable(), fileCreatedAt: z.string().nullable(),
  fileModifiedAt: z.string().nullable(), takenAt: z.string().nullable(),
  deviceId: z.string().nullable(), deviceAssetId: z.string().nullable(), libraryId: z.string().nullable(),
  albumsKnown: z.boolean().optional(),
  ruleMetadata: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
}).strict();
const configuredRuleSetSchema = z.unknown().transform((value, context): RuleSet => {
  try { return validateRuleSet(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid pinned ruleset" }); return z.NEVER; }
});
const configuredDecisionSchema = z.object({
  groupId: id, status: z.literal("auto-resolve"), keepAssetId: id, trashAssetIds: z.array(id).length(1),
  confidence: z.literal(100), matchedRuleId: id, matchedRuleName: id, reasons: z.array(z.string()),
  rulesetRevision: id, engineVersion: z.literal("1"), evidenceClass: z.enum(["checksum", "metadata"]),
  outcome: z.literal("eligible"), requiredFields: z.array(z.string()), missingFields: z.array(z.string()),
  dependencyFingerprint: z.string(), observedValues: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
}).strict();
export const configurableCandidateSchema = z.object({
  groupId: id, keepAsset: reviewedAssetSchema, trashAsset: reviewedAssetSchema,
  decision: configuredDecisionSchema, requiredAlbumIds: ids, proposedAlbumIds: ids, skippedAlbumIds: ids,
  ruleset: configuredRuleSetSchema, ruleAssets: z.array(ruleAssetSchema).length(2),
}).strict().superRefine((candidate, context) => {
  try {
    const group = candidateToGroup(candidate);
    const decision = evaluateConfiguredGroup(group, candidate.ruleset);
    const expected = candidateFromGroup(group, decision, candidate.ruleset);
    if (!isDeepStrictEqual(candidate, expected)) throw new Error("Invalid configured candidate");
  } catch { context.addIssue({ code: "custom", message: "Inconsistent configured rule evidence, selection or album actions" }); }
});
export const currentCandidateSchema = z.union([configurableCandidateSchema, reviewedCandidateSchema]);

export function candidateToGroup(candidate: Pick<ReviewedCandidate, "groupId" | "keepAsset" | "trashAsset"> & { ruleAssets?: AssetRecord[] }): DuplicateGroup {
  if (candidate.ruleAssets) return { groupId: candidate.groupId, assets: structuredClone(candidate.ruleAssets) };
  return { groupId: candidate.groupId, assets: [candidate.keepAsset, candidate.trashAsset].map((asset) => ({
    ...asset, originalMimeType: null, fileCreatedAt: null, fileModifiedAt: null, takenAt: null,
    deviceId: null, deviceAssetId: null, libraryId: null,
  })) };
}
export function projectAsset(asset: AssetRecord): ReviewedAsset {
  return { id: asset.id, duplicateId: asset.duplicateId, fileName: asset.fileName, originalPath: asset.originalPath,
    checksum: asset.checksum, assetType: asset.assetType, width: asset.width, height: asset.height, fileSize: asset.fileSize,
    isEdited: asset.isEdited, isTrashed: asset.isTrashed, isFavorite: asset.isFavorite, isArchived: asset.isArchived, isOffline: asset.isOffline,
    livePhotoVideoId: asset.livePhotoVideoId, isExternal: asset.isExternal, isInternal: asset.isInternal,
    albums: [...asset.albums].sort((a, b) => a.albumId.localeCompare(b.albumId)) };
}
export function candidateFromGroup(group: DuplicateGroup, decision: FreshPreflight["decision"], ruleset?: RuleSet): ReviewedCandidate {
  const keep = group.assets.find((a) => a.id === decision.keepAssetId)!;
  const trash = group.assets.find((a) => a.id === decision.trashAssetIds[0])!;
  // Invalid rules must be rejected by the caller rather than guessed into a candidate.
  if (!keep || !trash || group.assets.length !== 2 || keep.id === trash.id || group.assets.some((a) => a.duplicateId !== group.groupId)) throw new Error("Invalid reviewed candidate");
  const keepIds = new Set(keep.albums.map((a) => a.albumId));
  const trashIds = trash.albums.map((a) => a.albumId).sort((a, b) => a.localeCompare(b));
  return { groupId: group.groupId, keepAsset: projectAsset(keep), trashAsset: projectAsset(trash), decision,
    requiredAlbumIds: trashIds, proposedAlbumIds: trashIds.filter((a) => !keepIds.has(a)), skippedAlbumIds: trashIds.filter((a) => keepIds.has(a)),
    ...(ruleset ? { ruleset: structuredClone(ruleset), ruleAssets: [keep, trash].map((asset) => ({ ...structuredClone(asset), albums: [...asset.albums].sort((a, b) => a.albumId.localeCompare(b.albumId)) })) } : {}) };
}
export function reviewedCandidate(fresh: FreshPreflight, ruleset?: RuleSet): ReviewedCandidate { return candidateFromGroup(fresh.group, fresh.decision, ruleset); }
export function changedCandidate(expected: ReviewedCandidate, actual: ReviewedCandidate) {
  const reasons: string[] = [];
  if (expected.keepAsset.id !== actual.keepAsset.id || expected.trashAsset.id !== actual.trashAsset.id || expected.groupId !== actual.groupId) reasons.push("Group membership or keeper/loser selection changed");
  for (const side of ["keepAsset", "trashAsset"] as const) {
    const { albums: beforeAlbums, ...before } = expected[side];
    const { albums: afterAlbums, ...after } = actual[side];
    if (JSON.stringify(before) !== JSON.stringify(after)) reasons.push(`${side === "keepAsset" ? "Keeper" : "Loser"} metadata changed`);
    if (JSON.stringify(beforeAlbums) !== JSON.stringify(afterAlbums)) reasons.push(`${side === "keepAsset" ? "Keeper" : "Loser"} album memberships or names changed`);
  }
  if (JSON.stringify(expected.decision) !== JSON.stringify(actual.decision)) reasons.push("Rule decision changed");
  if (!isDeepStrictEqual(expected.requiredAlbumIds, actual.requiredAlbumIds) || !isDeepStrictEqual(expected.proposedAlbumIds, actual.proposedAlbumIds) || !isDeepStrictEqual(expected.skippedAlbumIds, actual.skippedAlbumIds)) reasons.push("Planned album actions changed");
  if (!isDeepStrictEqual(expected.ruleset, actual.ruleset)) reasons.push("Pinned ruleset changed");
  if (!isDeepStrictEqual(expected.ruleAssets, actual.ruleAssets)) reasons.push("Rule metadata changed");
  return reasons;
}

export const PLAN_TTL_MS = 15 * 60 * 1000;
export const PLAN_CAPACITY = 20;
type PlanEntry = { plan: ReviewedPlan; authorization: { selectedGroupIds: string[]; runId: string } | null };
export function createReviewedPlanStore(now: () => number) {
  const plans = new Map<string, PlanEntry>();
  function purge() { for (const [id, entry] of plans) if (Date.parse(entry.plan.expiresAt) <= now()) plans.delete(id); }
  return {
    put(input: Omit<ReviewedPlan, "planId" | "createdAt" | "expiresAt">, lifetime?: Pick<ReviewedPlan, "createdAt" | "expiresAt">) {
      purge();
      while (plans.size >= PLAN_CAPACITY) plans.delete(plans.keys().next().value!);
      const created = now();
      const plan: ReviewedPlan = { planId: randomUUID(), createdAt: lifetime?.createdAt ?? new Date(created).toISOString(), expiresAt: lifetime?.expiresAt ?? new Date(created + PLAN_TTL_MS).toISOString(), ...structuredClone(input) };
      plans.set(plan.planId, { plan, authorization: null });
      return structuredClone(plan);
    },
    get(id: string) { purge(); return plans.get(id); },
    remove(id: string) { plans.delete(id); },
  };
}
