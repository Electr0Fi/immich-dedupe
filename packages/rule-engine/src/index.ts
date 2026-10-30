import type {
  AssetRecord,
  DuplicateDecision,
  DuplicateGroup,
} from "@immich-dedupe/shared";

function sameResolution(a: AssetRecord, b: AssetRecord): boolean {
  return a.width != null && a.width > 0 && Number.isFinite(a.width) &&
    a.height != null && a.height > 0 && Number.isFinite(a.height) &&
    b.width != null &&
    b.height != null &&
    a.width === b.width &&
    a.height === b.height;
}

function sameFileName(a: AssetRecord, b: AssetRecord): boolean {
  return a.fileName.trim().length > 0 &&
    a.fileName.trim().toLowerCase() === b.fileName.trim().toLowerCase();
}

function isSafeCandidate(asset: AssetRecord): boolean {
  return asset.assetType === "IMAGE" &&
    asset.isEdited === false && asset.isTrashed === false &&
    asset.isFavorite === false && asset.isArchived === false && asset.isOffline === false &&
    asset.livePhotoVideoId === null;
}

function isSafeCandidatePair(a: AssetRecord, b: AssetRecord): boolean {
  return isSafeCandidate(a) && isSafeCandidate(b);
}

function chooseExternalVsInternal(
  a: AssetRecord,
  b: AssetRecord
): { keep: AssetRecord; trash: AssetRecord } | null {
  if (a.isExternal && !a.isInternal && b.isInternal && !b.isExternal) {
    return { keep: a, trash: b };
  }

  if (b.isExternal && !b.isInternal && a.isInternal && !a.isExternal) {
    return { keep: b, trash: a };
  }

  return null;
}

function ruleExternalLargerSameNameSameResolution(
  group: DuplicateGroup
): DuplicateDecision | null {
  if (group.assets.length !== 2) {
    return null;
  }

  const [a, b] = group.assets;

  if (!isSafeCandidatePair(a, b)) {
    return null;
  }

  if (!sameFileName(a, b)) {
    return null;
  }

  if (!sameResolution(a, b)) {
    return null;
  }

  const pair = chooseExternalVsInternal(a, b);
  if (!pair) {
    return null;
  }

  if (pair.keep.fileSize == null || pair.trash.fileSize == null) {
    return null;
  }

  if (!Number.isFinite(pair.keep.fileSize) || !Number.isFinite(pair.trash.fileSize) ||
      pair.keep.fileSize <= 0 || pair.trash.fileSize <= 0 || pair.keep.fileSize <= pair.trash.fileSize) {
    return null;
  }

  return {
    groupId: group.groupId,
    status: "auto-resolve",
    keepAssetId: pair.keep.id,
    trashAssetIds: [pair.trash.id],
    confidence: 100,
    matchedRuleId: "external-larger-same-name-same-resolution",
    matchedRuleName: "Keep external when larger, same filename, same resolution",
    reasons: [
      "Exactly 2 assets in duplicate group",
      "Both assets are images with complete safety metadata and no protected flags or Live Photo link",
      "Filenames match",
      "Resolution matches",
      "One asset is external and the other is internal",
      "External asset file size is larger",
    ],
  };
}

function ruleSameNameSameResolutionButMissingSize(
  group: DuplicateGroup
): DuplicateDecision | null {
  if (group.assets.length !== 2) {
    return null;
  }

  const [a, b] = group.assets;

  if (!isSafeCandidatePair(a, b)) {
    return null;
  }

  if (!sameFileName(a, b)) {
    return null;
  }

  if (!sameResolution(a, b)) {
    return null;
  }

  const pair = chooseExternalVsInternal(a, b);
  if (!pair) {
    return null;
  }

  if (pair.keep.fileSize != null && pair.trash.fileSize != null) {
    return null;
  }

  return {
    groupId: group.groupId,
    status: "uncertain",
    keepAssetId: null,
    trashAssetIds: [],
    confidence: 40,
    matchedRuleId: "same-name-same-resolution-missing-size",
    matchedRuleName: "Needs review because file size is missing",
    reasons: [
      "Exactly 2 assets in duplicate group",
      "Filenames match",
      "Resolution matches",
      "One asset is external and the other is internal",
      "At least one asset is missing file size",
    ],
  };
}

function ruleSkipDifferentResolution(group: DuplicateGroup): DuplicateDecision | null {
  if (group.assets.length !== 2) {
    return null;
  }

  const [a, b] = group.assets;

  if (!sameFileName(a, b)) {
    return null;
  }

  if (sameResolution(a, b)) {
    return null;
  }

  return {
    groupId: group.groupId,
    status: "skip",
    keepAssetId: null,
    trashAssetIds: [],
    confidence: 0,
    matchedRuleId: "skip-different-resolution",
    matchedRuleName: "Skip when resolution differs",
    reasons: [
      "Filenames match",
      "Resolution differs",
      "Group should not be auto-resolved",
    ],
  };
}

function defaultUncertain(group: DuplicateGroup): DuplicateDecision {
  return {
    groupId: group.groupId,
    status: "uncertain",
    keepAssetId: null,
    trashAssetIds: [],
    confidence: 10,
    matchedRuleId: null,
    matchedRuleName: null,
    reasons: ["No deterministic rule matched"],
  };
}

export function evaluateDuplicateGroup(group: DuplicateGroup): DuplicateDecision {
  if (group.assets.some((asset) => !isSafeCandidate(asset))) {
    return {
      ...defaultUncertain(group),
      reasons: ["Automatic cleanup requires images with complete safety metadata; favorites, archived/offline, edited/trashed and linked Live Photo assets are excluded"],
    };
  }
  const rules = [
    ruleExternalLargerSameNameSameResolution,
    ruleSameNameSameResolutionButMissingSize,
    ruleSkipDifferentResolution,
  ];

  for (const rule of rules) {
    const result = rule(group);
    if (result) {
      return result;
    }
  }

  return defaultUncertain(group);
}

export function evaluateDuplicateGroups(groups: DuplicateGroup[]): DuplicateDecision[] {
  return groups.map(evaluateDuplicateGroup);
}
