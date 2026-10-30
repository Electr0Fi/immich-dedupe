import { z } from "zod";
import type { AssetResponseDto } from "@immich/sdk";
import { evaluateDuplicateGroup } from "@immich-dedupe/rule-engine";
import type { DuplicateDecision, DuplicateGroup, ExecutionFailureStage, ExecutionResult, ExecutionCheckpoint } from "@immich-dedupe/shared";
import type { ImmichClient } from "./immichClient";
import { readFreshPreflight, albumDetailSchema, type FreshPreflight } from "./freshPreflight";
export { assetSchema, albumDetailSchema, groupListSchema } from "./freshPreflight";

const resolutionSchema = z.array(z.object({
  id: z.string().min(1), success: z.literal(true), error: z.unknown().optional(), errorMessage: z.string().optional(),
})).nonempty();

export class CheckpointFailure extends Error {
  constructor(public result: ExecutionResult) { super("Recovery checkpoint could not be persisted; execution stopped"); }
}

export function createDecisionExecutor(
  client: Pick<ImmichClient, "addAssetsToAlbums" | "getAssetInfo" | "resolveDuplicates" | "getAssetDuplicates" | "getAllAlbums" | "getAlbumInfo">,
  options: { delay?: (ms: number) => Promise<void>; onCheckpoint?: (event: ExecutionCheckpoint) => Promise<void>; validatePreflight?: (fresh: FreshPreflight) => void } = {}
) {
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async function executeDuplicateDecision(
    group: DuplicateGroup, decision: DuplicateDecision, dryRun = true
  ): Promise<ExecutionResult> {
    const result: ExecutionResult = {
      groupId: group.groupId, mode: dryRun ? "dry-run" : "execute",
      outcome: "failed", failureStage: null, executed: false,
      keepAssetId: decision.keepAssetId, trashAssetId: decision.trashAssetIds[0] ?? null,
      proposedAlbumIds: [], transferredAlbumIds: [], skippedAlbumIds: [],
      resolvedDuplicate: false, trashedAsset: false, message: "",
    };
    let stage: ExecutionFailureStage = "preflight";
    let mutationSubmitted = false;
    const checkpoint = async (event: ExecutionCheckpoint) => {
      try { await options.onCheckpoint?.(event); }
      catch {
        throw new CheckpointFailure({ ...result, outcome: mutationSubmitted ? "needs-verification" : "failed", failureStage: stage,
          message: "Recovery checkpoint could not be persisted; inspect recovery evidence before retrying" });
      }
    };
    try {
      const keepId = result.keepAssetId;
      const trashId = result.trashAssetId;
      const expected = evaluateDuplicateGroup(group);
      if (group.groupId !== decision.groupId || group.assets.length !== 2 || !keepId || !trashId || keepId === trashId ||
          decision.status !== "auto-resolve" || decision.confidence !== 100 || decision.trashAssetIds.length !== 1 ||
          expected.status !== "auto-resolve" || expected.keepAssetId !== keepId || expected.trashAssetIds[0] !== trashId) {
        throw new Error("Safety guard failed: invalid group or decision");
      }

      const fresh = await readFreshPreflight(client, group.groupId, { keepId, trashId });
      options.validatePreflight?.(fresh);
      result.proposedAlbumIds = fresh.proposedAlbumIds;
      result.skippedAlbumIds = fresh.skippedAlbumIds;
      await checkpoint({ kind: "preflight", snapshot: fresh.group.assets,
        requiredAlbumIds: fresh.requiredAlbumIds,
        proposedAlbumIds: result.proposedAlbumIds, skippedAlbumIds: result.skippedAlbumIds });
      if (dryRun) {
        result.outcome = "dry-run";
        result.message = "Dry run: no changes executed";
        return result;
      }

      if (result.proposedAlbumIds.length) {
        stage = "album-transfer";
        await checkpoint({ kind: "album-intent", albumIds: result.proposedAlbumIds });
        mutationSubmitted = true;
        let response: Awaited<ReturnType<ImmichClient["addAssetsToAlbums"]>> | undefined;
        let transferError: unknown;
        try {
          response = await client.addAssetsToAlbums({ albumsAddAssetsDto: {
            assetIds: [keepId], albumIds: result.proposedAlbumIds,
          } });
        } catch (error) {
          transferError = error;
        }
        await checkpoint({ kind: "album-response", accepted: response?.success === true && response.error == null,
          error: transferError ? "Album request failed or its response was lost" : response?.success === true ? null : "Album request did not explicitly succeed" });
        // Even a failed/ambiguous response can follow partial changes: retain positive membership evidence.
        stage = "album-verification";
        const checks = await Promise.allSettled(result.proposedAlbumIds.map(async (id) => {
          const album = albumDetailSchema.parse(await client.getAlbumInfo({ id, withoutAssets: false }));
          return album.id === id && album.assets.some((asset) => asset.id === keepId);
        }));
        result.transferredAlbumIds = result.proposedAlbumIds.filter((_, index) => {
          const check = checks[index];
          return check.status === "fulfilled" && check.value;
        });
        await checkpoint({ kind: "album-observed", confirmedAlbumIds: result.transferredAlbumIds });
        if (response?.success !== true || response.error != null) {
          stage = "album-transfer";
          throw new Error(transferError instanceof Error ? transferError.message :
            "Album transfer did not explicitly succeed; duplicate resolution was not called");
        }
        if (result.transferredAlbumIds.length !== result.proposedAlbumIds.length) {
          throw new Error("Album membership could not be confirmed; duplicate resolution was not called");
        }
      }

      // Verify overlapping memberships too; preservation must not rely only on the earlier list.
      stage = "album-verification";
      for (const id of result.skippedAlbumIds) {
        const album = albumDetailSchema.parse(await client.getAlbumInfo({ id, withoutAssets: false }));
        if (album.id !== id || !album.assets.some((asset) => asset.id === keepId)) {
          throw new Error("Existing keeper album membership could not be confirmed");
        }
      }

      stage = "resolution";
      await checkpoint({ kind: "resolution-intent" });
      mutationSubmitted = true;
      let response: Awaited<ReturnType<ImmichClient["resolveDuplicates"]>> | undefined;
      let resolutionError: unknown;
      try {
        response = await client.resolveDuplicates({ duplicateResolveDto: {
          groups: [{ duplicateId: group.groupId, keepAssetIds: [keepId], trashAssetIds: [trashId] }],
        } });
      } catch (error) { resolutionError = error; }
      const parsedResponse = resolutionSchema.safeParse(response);
      const accepted = parsedResponse.success && !parsedResponse.data.some((entry) => entry.error != null || entry.errorMessage);
      await checkpoint({ kind: "resolution-response", accepted,
        items: Array.isArray(response) ? response.filter((item) => item && typeof item.id === "string" && typeof item.success === "boolean").map(({ id, success }) => ({ id, success })) : [],
        error: accepted ? null : "Resolution request did not explicitly succeed or its response was lost" });
      if (!accepted) throw new Error(resolutionError instanceof Error ? resolutionError.message : "Duplicate resolution did not explicitly succeed");

      stage = "verification";
      for (let round = 0; round < 3; round++) {
        if (round) await delay(1000);
        const [loser, keeper]: [PromiseSettledResult<AssetResponseDto>, PromiseSettledResult<AssetResponseDto>] = await Promise.allSettled([
          client.getAssetInfo({ id: trashId }), client.getAssetInfo({ id: keepId }),
        ]);
        const trashConfirmed = loser.status === "fulfilled" && loser.value?.id === trashId && loser.value.isTrashed === true;
        result.trashedAsset ||= trashConfirmed;
        const resolved = trashConfirmed && loser.status === "fulfilled" && loser.value.duplicateId === null;
        const kept = keeper.status === "fulfilled" && keeper.value?.id === keepId && keeper.value.isTrashed === false;
        result.resolvedDuplicate ||= resolved;
        await checkpoint({ kind: "verification", loserTrashed: trashConfirmed, loserUnlinked: resolved, keeperUntrashed: kept });
        if (resolved && kept) {
          result.outcome = "succeeded";
          result.executed = true;
          result.message = "Album membership confirmed and duplicate resolution verified";
          return result;
        }
      }
      throw new Error("Resolution could not be fully verified after three checks; investigate before retrying");
    } catch (error) {
      if (error instanceof CheckpointFailure) throw error;
      result.outcome = mutationSubmitted ? "needs-verification" : "failed";
      result.failureStage = stage;
      // Zod diagnostics can contain upstream payload details; keep errors concise and free of response dumps.
      result.message = error instanceof z.ZodError ? `Invalid or incomplete response during ${stage}` :
        error instanceof Error ? error.message : `Unknown error during ${stage}`;
      return result;
    }
  };
}
