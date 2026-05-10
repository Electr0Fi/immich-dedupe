import type {
  AssetRecord,
  DuplicateGroup,
  NormalizedDuplicatesResponse,
} from "@immich-dedupe/shared";
import { classifySource } from "./classifySource";

type RawAsset = {
  id: string;
  duplicateId?: string | null;
  deviceAssetId?: string | null;
  deviceId?: string | null;
  libraryId?: string | null;
  originalPath?: string | null;
  originalFileName?: string | null;
  originalMimeType?: string | null;
  fileCreatedAt?: string | null;
  fileModifiedAt?: string | null;
  localDateTime?: string | null;
  checksum?: string | null;
  width?: number | null;
  height?: number | null;
  isEdited?: boolean | null;
  isTrashed?: boolean | null;
  exifInfo?: {
    exifImageWidth?: number | null;
    exifImageHeight?: number | null;
  } | null;
};

type RawDuplicateGroup = {
  duplicateId: string;
  assets: RawAsset[];
};

function normalizeAsset(raw: RawAsset, groupId: string): AssetRecord {
  const originalPath = raw.originalPath ?? null;
  const { isExternal, isInternal } = classifySource(originalPath);

  return {
    id: raw.id,
    duplicateId: raw.duplicateId ?? groupId,
    fileName: raw.originalFileName ?? "unknown",
    originalPath,
    originalMimeType: raw.originalMimeType ?? null,
    fileCreatedAt: raw.fileCreatedAt ?? null,
    fileModifiedAt: raw.fileModifiedAt ?? null,
    takenAt: raw.localDateTime ?? null,
    width: raw.width ?? raw.exifInfo?.exifImageWidth ?? null,
    height: raw.height ?? raw.exifInfo?.exifImageHeight ?? null,
    checksum: raw.checksum ?? null,
    deviceId: raw.deviceId ?? null,
    deviceAssetId: raw.deviceAssetId ?? null,
    libraryId: raw.libraryId ?? null,
    isEdited: raw.isEdited ?? false,
    isTrashed: raw.isTrashed ?? false,
    isExternal,
    isInternal,
    fileSize: null,
    albums: [],
  };
}

export function normalizeDuplicates(
  rawGroups: RawDuplicateGroup[]
): NormalizedDuplicatesResponse {
  const groups: DuplicateGroup[] = rawGroups.map((group) => ({
    groupId: group.duplicateId,
    assets: group.assets.map((asset) => normalizeAsset(asset, group.duplicateId)),
  }));

  const totalAssets = groups.reduce((sum, group) => sum + group.assets.length, 0);

  return {
    groups,
    totalGroups: groups.length,
    totalAssets,
  };
}
