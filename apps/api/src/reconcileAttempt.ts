import { z } from "zod";
import type { RecoveryAttempt, RecoveryAssessment } from "@immich-dedupe/shared";
import { evaluateDuplicateGroup } from "@immich-dedupe/rule-engine";
import { assetSchema, albumDetailSchema, groupListSchema } from "./executeDecision";
import { normalizeDuplicates } from "./normalizeDuplicates";
import type { ImmichClient } from "./immichClient";

const currentStateSchema = z.object({ id: z.string().min(1), isTrashed: z.boolean(), duplicateId: z.string().nullable().optional() });

/** Observe only; never repair, restore, transfer, or resolve anything in Immich. */
export async function reconcileAttempt(client: ImmichClient, attempt: RecoveryAttempt,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<RecoveryAssessment> {
  let message = "Current state could not be verified";
  for (let round = 0; round < 3; round++) {
    if (round) await delay(1000);
    try {
      if (!attempt.keepAssetId || !attempt.trashAssetId || attempt.keepAssetId === attempt.trashAssetId) throw new Error("Selected asset IDs are incomplete");
      const preflight = attempt.checkpoints.find((c) => c.event.kind === "preflight")?.event;
      const hasIntent = attempt.checkpoints.some((c) => c.event.kind === "album-intent" || c.event.kind === "resolution-intent");
      if (hasIntent && preflight?.kind !== "preflight") throw new Error("Original album requirements are missing");
      const required = preflight?.kind === "preflight" ? preflight.requiredAlbumIds : [];
      const [rawKeeper, rawLoser, rawGroups] = await Promise.all([
        client.getAssetInfo({ id: attempt.keepAssetId }), client.getAssetInfo({ id: attempt.trashAssetId }), client.getAssetDuplicates({}),
      ]);
      const keeper = currentStateSchema.parse(rawKeeper), loser = currentStateSchema.parse(rawLoser);
      if (keeper.id !== attempt.keepAssetId || loser.id !== attempt.trashAssetId) throw new Error("Asset identity does not match the attempt");
      const groups = groupListSchema.parse(rawGroups);
      const albums = await Promise.all(required.map(async (id) => {
        const album = albumDetailSchema.parse(await client.getAlbumInfo({ id, withoutAssets: false }));
        if (album.id !== id) throw new Error("Album identity changed");
        return album;
      }));
      if (preflight?.kind === "preflight" && loser.isTrashed === true && loser.duplicateId === null && keeper.isTrashed === false &&
          !groups.some((g) => g.duplicateId === attempt.groupId) && albums.every((album) => album.assets.some((a) => a.id === keeper.id))) {
        return { checkedAt: new Date().toISOString(), classification: "verified-resolved",
          message: "Resolution and required keeper album memberships are verified; no cleanup was repeated",
          evidence: ["Loser is trashed and unlinked", "Keeper is untrashed", "Original group is absent", "Required albums contain keeper"] };
      }
      const matching = groups.filter((g) => g.duplicateId === attempt.groupId);
      if (keeper.isTrashed || loser.isTrashed || keeper.duplicateId !== attempt.groupId || loser.duplicateId !== attempt.groupId || matching.length !== 1 ||
          matching[0].assets.length !== 2 || new Set(matching[0].assets.map((a) => a.id)).size !== 2 ||
          !matching[0].assets.some((a) => a.id === keeper.id) || !matching[0].assets.some((a) => a.id === loser.id)) throw new Error("Original pair is no longer intact");
      // Eligibility for a new attempt still requires all fresh safety metadata.
      const freshKeeper = assetSchema.parse(rawKeeper), freshLoser = assetSchema.parse(rawLoser);
      const group = normalizeDuplicates([{ duplicateId: attempt.groupId, assets: [freshKeeper, freshLoser] }]).groups[0];
      [freshKeeper, freshLoser].forEach((asset, index) => {
        const size = asset.exifInfo?.fileSizeInByte;
        group.assets[index].fileSize = size == null || (typeof size === "string" && !size.trim()) ? null : Number(size);
      });
      const decision = evaluateDuplicateGroup(group);
      if (decision.status !== "auto-resolve" || decision.keepAssetId !== keeper.id || decision.trashAssetIds[0] !== loser.id) throw new Error("Fresh eligibility no longer supports the original selection");
      if (!albums.every((album) => album.assets.some((a) => a.id === keeper.id || a.id === loser.id))) throw new Error("Original album memberships are no longer accounted for");
      return { checkedAt: new Date().toISOString(), classification: "pair-intact",
        message: "The original pair is currently intact and eligible; explicit release is required before a new attempt",
        evidence: ["Same two assets remain in the group", "Same keeper/loser remain eligible", "Original album requirements are accounted for"] };
    } catch (error) {
      message = error instanceof Error && error.name !== "ZodError" ? error.message : "Required asset, album or group information is incomplete";
    }
  }
  return { checkedAt: new Date().toISOString(), classification: "inconclusive", message, evidence: [] };
}
