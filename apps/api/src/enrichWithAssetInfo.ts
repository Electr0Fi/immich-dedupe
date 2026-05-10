import type {
  AssetRecord,
  DuplicateGroup,
  NormalizedDuplicatesResponse,
} from "@immich-dedupe/shared";
import { getAssetInfo } from "@immich/sdk";

type RawAssetInfo = {
  exifInfo?: {
    fileSizeInByte?: number | string | null;
  } | null;
};

const fileSizeCache = new Map<string, number | null>();

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractFileSize(assetInfo: RawAssetInfo): number | null {
  return toNumberOrNull(assetInfo.exifInfo?.fileSizeInByte ?? null);
}

async function enrichAsset(asset: AssetRecord): Promise<AssetRecord> {
  if (fileSizeCache.has(asset.id)) {
    return {
      ...asset,
      fileSize: fileSizeCache.get(asset.id) ?? null,
    };
  }

  const assetInfo = (await getAssetInfo({ id: asset.id })) as RawAssetInfo;
  const fileSize = extractFileSize(assetInfo);

  fileSizeCache.set(asset.id, fileSize);

  return {
    ...asset,
    fileSize,
  };
}

async function enrichGroup(group: DuplicateGroup): Promise<DuplicateGroup> {
  const assets = await Promise.all(group.assets.map(enrichAsset));

  return {
    ...group,
    assets,
  };
}

export async function enrichDuplicatesWithAssetInfo(
  normalized: NormalizedDuplicatesResponse
): Promise<NormalizedDuplicatesResponse> {
  const groups = await Promise.all(normalized.groups.map(enrichGroup));

  const totalAssets = groups.reduce((sum, group) => sum + group.assets.length, 0);

  return {
    groups,
    totalGroups: groups.length,
    totalAssets,
  };
}