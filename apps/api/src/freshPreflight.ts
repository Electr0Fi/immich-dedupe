import { z } from "zod";
import { evaluateDuplicateGroup, evaluateConfiguredGroup } from "@immich-dedupe/rule-engine";
import type { RuleSet } from "@immich-dedupe/shared";
import { normalizeDuplicates } from "./normalizeDuplicates";
import type { ImmichClient } from "./immichClient";

export const assetSchema = z.object({
  id: z.string().min(1), duplicateId: z.string().nullable(),
  originalFileName: z.string().min(1), originalPath: z.string().min(1),
  checksum: z.string().nullable().optional(),
  type: z.string(), width: z.number().nullable(), height: z.number().nullable(),
  isEdited: z.boolean(), isTrashed: z.boolean(), isFavorite: z.boolean(),
  isArchived: z.boolean(), isOffline: z.boolean(),
  livePhotoVideoId: z.string().nullable().optional(),
  exifInfo: z.object({
    fileSizeInByte: z.union([z.number(), z.string()]).nullish(),
    exifImageWidth: z.number().nullish(), exifImageHeight: z.number().nullish(),
  }).passthrough().nullish(),
}).passthrough();
const albumListSchema = z.array(z.object({ id: z.string().min(1), albumName: z.string() }));
export const albumDetailSchema = z.object({ id: z.string().min(1), assets: z.array(z.object({ id: z.string().min(1) })) });
export const groupListSchema = z.array(z.object({ duplicateId: z.string().min(1), assets: z.array(z.object({ id: z.string().min(1) })) }));
export class PreflightSafetyError extends Error {
  constructor(message: string, public classification: "excluded" | "deferred" = "excluded") { super(message); }
}
export type PreflightClient = Pick<ImmichClient, "getAssetDuplicates" | "getAssetInfo" | "getAllAlbums">;

/** Fresh, uncached reads shared by legacy execution and immutable reviews. Never mutates Immich. */
export async function readFreshPreflight(client: PreflightClient, groupId: string, selection?: { keepId: string; trashId: string }, preparation?: {
  checkCancelled: () => void;
  stage: (stage: "checking-membership" | "checking-assets" | "checking-albums") => void;
}, configuration?: { ruleset?: RuleSet; memberships?: z.infer<typeof groupListSchema> }) {
  async function reads<T>(pending: Promise<T>[]): Promise<T[]> {
    if (!preparation) return Promise.all(pending);
    const settled = await Promise.allSettled(pending);
    return settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }
  preparation?.checkCancelled();
  preparation?.stage("checking-membership");
  // Only review preparation supplies a request-owned snapshot. Execution always refetches.
  const memberships = configuration?.memberships ?? groupListSchema.parse(await client.getAssetDuplicates({}));
  preparation?.checkCancelled();
  const matches = memberships.filter((item) => item.duplicateId === groupId);
  if (matches.length === 0) {
    throw new PreflightSafetyError("Immich no longer returns this duplicate group. It may have been resolved or regrouped; prepare a new review.");
  }
  if (matches.length > 1) {
    throw new PreflightSafetyError(`Immich returned ${matches.length} entries for this duplicate group; its membership could not be verified.`);
  }
  const assets = matches[0].assets;
  if (assets.length !== 2) {
    throw new PreflightSafetyError(`${assets.length} ${assets.length === 1 ? "asset" : "assets"} in group; current rule definitions only support exactly 2 assets per group.`);
  }
  if (new Set(assets.map((asset) => asset.id)).size !== 2) {
    throw new PreflightSafetyError("The group contains repeated asset IDs; current rule definitions require 2 distinct assets per group.");
  }
  if (selection && ![selection.keepId, selection.trashId].every((id) => assets.some((asset) => asset.id === id))) {
    throw new PreflightSafetyError("The selected keeper or asset to trash is no longer in this duplicate group. Prepare a new review.");
  }
  const ids = selection ? [selection.keepId, selection.trashId] : assets.map((asset) => asset.id);
  preparation?.stage("checking-assets");
  const freshAssets = await reads(ids.map(async (id) => {
    const parsed = assetSchema.safeParse(await client.getAssetInfo({ id }));
    if (!parsed.success) throw new PreflightSafetyError("Invalid or incomplete response during preflight", "deferred");
    if (configuration?.ruleset && parsed.data.livePhotoVideoId === undefined) throw new PreflightSafetyError("Live Photo linkage is missing; this image cannot be verified safely", "deferred");
    if (parsed.data.id !== id || parsed.data.duplicateId !== groupId) throw new PreflightSafetyError("Safety guard failed: asset membership changed");
    return parsed.data;
  }));
  preparation?.checkCancelled();
  const group = normalizeDuplicates([{ duplicateId: groupId, assets: freshAssets }]).groups[0];
  group.assets.forEach((asset, index) => {
    const value = freshAssets[index].exifInfo?.fileSizeInByte;
    asset.fileSize = value == null || (typeof value === "string" && !value.trim()) ? null : Number(value);
  });
  const evaluate = () => configuration?.ruleset ? evaluateConfiguredGroup(group, configuration.ruleset) : evaluateDuplicateGroup(group);
  let decision = evaluate();
  async function albumsFor(assetId: string) {
    const lists = await reads([client.getAllAlbums({ assetId }), client.getAllAlbums({ assetId, shared: true })]);
    const entries = lists.flatMap((list) => albumListSchema.parse(list));
    const map = new Map<string, { id: string; albumName: string }>();
    for (const entry of entries) {
      if (map.has(entry.id) && map.get(entry.id)!.albumName !== entry.albumName) throw new Error("Conflicting album information during preflight");
      map.set(entry.id, entry);
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  if (!configuration?.ruleset && decision.status !== "auto-resolve") throw new PreflightSafetyError("Safety guard failed: fresh asset details no longer support the selected resolution");
  if (configuration?.ruleset && decision.status !== "auto-resolve" && !("missingFields" in decision && (decision.missingFields as string[]).some((field) => /(?:^|\.)album(?:Id|Name)$/.test(field)))) {
    throw new PreflightSafetyError(decision.reasons.join("; "), "outcome" in decision && decision.outcome === "deferred" ? "deferred" : "excluded");
  }
  preparation?.stage("checking-albums");
  const albumLists = await reads(group.assets.map((asset) => albumsFor(asset.id)));
  preparation?.checkCancelled();
  group.assets.forEach((asset, index) => { asset.albums = albumLists[index].map((a) => ({ albumId: a.id, albumName: a.albumName })); asset.albumsKnown = true; });
  decision = evaluate();
  if (decision.status !== "auto-resolve" || decision.confidence !== 100 || !decision.keepAssetId || decision.trashAssetIds.length !== 1 ||
      (selection && (decision.keepAssetId !== selection.keepId || decision.trashAssetIds[0] !== selection.trashId))) {
    throw new PreflightSafetyError(configuration?.ruleset ? decision.reasons.join("; ") : "Safety guard failed: fresh asset details no longer support the selected resolution", "outcome" in decision && decision.outcome === "deferred" ? "deferred" : "excluded");
  }
  const keepId = decision.keepAssetId, trashId = decision.trashAssetIds[0];
  const keepAlbums = albumLists[group.assets.findIndex((asset) => asset.id === keepId)];
  const trashAlbums = albumLists[group.assets.findIndex((asset) => asset.id === trashId)];
  const keepIds = new Set(keepAlbums.map((a) => a.id));
  return { group, decision, ...(configuration?.ruleset ? { ruleset: configuration.ruleset } : {}), requiredAlbumIds: trashAlbums.map((a) => a.id),
    proposedAlbumIds: trashAlbums.filter((a) => !keepIds.has(a.id)).map((a) => a.id),
    skippedAlbumIds: trashAlbums.filter((a) => keepIds.has(a.id)).map((a) => a.id) };
}
export type FreshPreflight = Awaited<ReturnType<typeof readFreshPreflight>>;
