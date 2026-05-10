import type {
  DuplicateDecision,
  DuplicateGroup,
  ExecutionResult,
} from "@immich-dedupe/shared";
import { addAssetsToAlbums, getAssetInfo, resolveDuplicates } from "@immich/sdk";

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function validateExecutionSafety(
  group: DuplicateGroup,
  decision: DuplicateDecision
): string | null {
  if (group.assets.length !== 2) {
    return "Safety guard failed: group must contain exactly 2 assets";
  }

  const externalCount = group.assets.filter((asset) => asset.isExternal).length;
  const internalCount = group.assets.filter((asset) => asset.isInternal).length;

  if (externalCount !== 1 || internalCount !== 1) {
    return "Safety guard failed: group must contain exactly 1 external and 1 internal asset";
  }

  if (decision.status !== "auto-resolve" || decision.confidence !== 100) {
    return "Safety guard failed: decision must be auto-resolve with confidence 100";
  }

  if (decision.trashAssetIds.length !== 1) {
    return "Safety guard failed: decision must contain exactly 1 trash asset ID";
  }

  if (!decision.keepAssetId || decision.keepAssetId === decision.trashAssetIds[0]) {
    return "Safety guard failed: keep asset ID must exist and differ from trash asset ID";
  }

  return null;
}

async function verifyAssetIsTrashed(assetId: string): Promise<boolean> {
  try {
    const asset = await getAssetInfo({ id: assetId });

    return (
      typeof asset === "object" &&
      asset !== null &&
      "isTrashed" in asset &&
      asset.isTrashed === true
    );
  } catch {
    return true;
  }
}

function buildFailureResult(
  group: DuplicateGroup,
  decision: DuplicateDecision,
  dryRun: boolean,
  message: string
): ExecutionResult {
  return {
    groupId: group.groupId,
    mode: dryRun ? "dry-run" : "execute",
    executed: false,
    keepAssetId: decision.keepAssetId,
    trashAssetId: decision.trashAssetIds[0] ?? null,
    transferredAlbumIds: [],
    skippedAlbumIds: [],
    resolvedDuplicate: false,
    trashedAsset: false,
    message,
  };
}

export async function executeDuplicateDecision(
  group: DuplicateGroup,
  decision: DuplicateDecision,
  dryRun = false
): Promise<ExecutionResult> {
  const mode = dryRun ? "dry-run" : "execute";

  const safetyError = validateExecutionSafety(group, decision);

  if (safetyError) {
    return buildFailureResult(group, decision, dryRun, safetyError);
  }

  const keepAsset = group.assets.find((asset) => asset.id === decision.keepAssetId);
  const trashAsset = group.assets.find(
    (asset) => asset.id === decision.trashAssetIds[0]
  );

  if (!keepAsset || !trashAsset) {
    return buildFailureResult(
      group,
      decision,
      dryRun,
      "Safety guard failed: keep or trash asset not found in group"
    );
  }

  const keepAlbumIds = unique(keepAsset.albums.map((album) => album.albumId));
  const trashAlbumIds = unique(trashAsset.albums.map((album) => album.albumId));

  const missingAlbumIds = trashAlbumIds.filter(
    (albumId) => !keepAlbumIds.includes(albumId)
  );

  const overlappingAlbumIds = keepAlbumIds.filter((albumId) =>
    trashAlbumIds.includes(albumId)
  );

  if (dryRun) {
    return {
      groupId: group.groupId,
      mode,
      executed: false,
      keepAssetId: keepAsset.id,
      trashAssetId: trashAsset.id,
      transferredAlbumIds: missingAlbumIds,
      skippedAlbumIds: overlappingAlbumIds,
      resolvedDuplicate: false,
      trashedAsset: false,
      message: "Dry run: no changes executed",
    };
  }

  if (missingAlbumIds.length > 0) {
    await addAssetsToAlbums({
      albumsAddAssetsDto: {
        assetIds: [keepAsset.id],
        albumIds: missingAlbumIds,
      },
    });
  }

  await resolveDuplicates({
    duplicateResolveDto: {
      groups: [
        {
          duplicateId: group.groupId,
          keepAssetIds: [keepAsset.id],
          trashAssetIds: [trashAsset.id],
        },
      ],
    },
  });

  const trashVerified = await verifyAssetIsTrashed(trashAsset.id);

  if (!trashVerified) {
    return {
      groupId: group.groupId,
      mode,
      executed: false,
      keepAssetId: keepAsset.id,
      trashAssetId: trashAsset.id,
      transferredAlbumIds: missingAlbumIds,
      skippedAlbumIds: overlappingAlbumIds,
      resolvedDuplicate: false,
      trashedAsset: false,
      message:
        "Resolve failed: loser asset still exists and is not trashed after resolveDuplicates call",
    };
  }

  return {
    groupId: group.groupId,
    mode,
    executed: true,
    keepAssetId: keepAsset.id,
    trashAssetId: trashAsset.id,
    transferredAlbumIds: missingAlbumIds,
    skippedAlbumIds: overlappingAlbumIds,
    resolvedDuplicate: true,
    trashedAsset: true,
    message: "Album transfer completed and duplicate resolved",
  };
}
