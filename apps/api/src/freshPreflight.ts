import { z } from "zod";
import { evaluateDuplicateGroup } from "@immich-dedupe/rule-engine";
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
  }).nullish(),
});
const albumListSchema = z.array(z.object({ id: z.string().min(1), albumName: z.string() }));
export const albumDetailSchema = z.object({ id: z.string().min(1), assets: z.array(z.object({ id: z.string().min(1) })) });
export const groupListSchema = z.array(z.object({ duplicateId: z.string().min(1), assets: z.array(z.object({ id: z.string().min(1) })) }));
export class PreflightSafetyError extends Error {}
export type PreflightClient = Pick<ImmichClient, "getAssetDuplicates" | "getAssetInfo" | "getAllAlbums">;

/** Fresh, uncached reads shared by legacy execution and immutable reviews. Never mutates Immich. */
export async function readFreshPreflight(client: PreflightClient, groupId: string, selection?: { keepId: string; trashId: string }) {
  const memberships = groupListSchema.parse(await client.getAssetDuplicates({}));
  const matches = memberships.filter((item) => item.duplicateId === groupId);
  if (matches.length !== 1 || matches[0].assets.length !== 2 || new Set(matches[0].assets.map((asset) => asset.id)).size !== 2 ||
      (selection && ![selection.keepId, selection.trashId].every((id) => matches[0].assets.some((a) => a.id === id)))) {
    throw new PreflightSafetyError("Safety guard failed: duplicate group membership changed");
  }
  const ids = selection ? [selection.keepId, selection.trashId] : matches[0].assets.map((a) => a.id);
  const freshAssets = await Promise.all(ids.map(async (id) => {
    const parsed = assetSchema.safeParse(await client.getAssetInfo({ id }));
    if (!parsed.success) throw new PreflightSafetyError("Invalid or incomplete response during preflight");
    if (parsed.data.id !== id || parsed.data.duplicateId !== groupId) throw new PreflightSafetyError("Safety guard failed: asset membership changed");
    return parsed.data;
  }));
  const group = normalizeDuplicates([{ duplicateId: groupId, assets: freshAssets }]).groups[0];
  group.assets.forEach((asset, index) => {
    const value = freshAssets[index].exifInfo?.fileSizeInByte;
    asset.fileSize = value == null || (typeof value === "string" && !value.trim()) ? null : Number(value);
  });
  const decision = evaluateDuplicateGroup(group);
  if (decision.status !== "auto-resolve" || decision.confidence !== 100 || !decision.keepAssetId || decision.trashAssetIds.length !== 1 ||
      (selection && (decision.keepAssetId !== selection.keepId || decision.trashAssetIds[0] !== selection.trashId))) {
    throw new PreflightSafetyError("Safety guard failed: fresh asset details no longer support the selected resolution");
  }
  async function albumsFor(assetId: string) {
    const lists = await Promise.all([client.getAllAlbums({ assetId }), client.getAllAlbums({ assetId, shared: true })]);
    const entries = lists.flatMap((list) => albumListSchema.parse(list));
    const map = new Map<string, { id: string; albumName: string }>();
    for (const entry of entries) {
      if (map.has(entry.id) && map.get(entry.id)!.albumName !== entry.albumName) throw new Error("Conflicting album information during preflight");
      map.set(entry.id, entry);
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  const keepId = decision.keepAssetId, trashId = decision.trashAssetIds[0];
  const [keepAlbums, trashAlbums] = await Promise.all([albumsFor(keepId), albumsFor(trashId)]);
  for (const asset of group.assets) asset.albums = (asset.id === keepId ? keepAlbums : trashAlbums).map((a) => ({ albumId: a.id, albumName: a.albumName }));
  const keepIds = new Set(keepAlbums.map((a) => a.id));
  return { group, decision, requiredAlbumIds: trashAlbums.map((a) => a.id),
    proposedAlbumIds: trashAlbums.filter((a) => !keepIds.has(a.id)).map((a) => a.id),
    skippedAlbumIds: trashAlbums.filter((a) => keepIds.has(a.id)).map((a) => a.id) };
}
export type FreshPreflight = Awaited<ReturnType<typeof readFreshPreflight>>;
