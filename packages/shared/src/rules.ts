import type { AssetRecord, DuplicateDecision } from "./types";

export const RULE_FIELDS = ["checksum", "fileName", "fileNameStem", "extension", "originalPath", "originalMimeType", "fileSize", "width", "height", "pixelCount", "aspectRatio", "takenAt", "fileCreatedAt", "fileModifiedAt", "libraryId", "deviceId", "assetType", "albumId", "albumName", "exif.make", "exif.model", "exif.lensModel", "exif.orientation", "exif.fNumber", "exif.iso", "exif.exposureTime", "exif.rating"] as const;
export type RuleField = typeof RULE_FIELDS[number];
export type RuleOperator = "same" | "different" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between" | "prefix" | "glob" | "missing" | "within";
export type RuleCondition = { all: RuleCondition[] } | { any: RuleCondition[] } | {
  field: RuleField; operator: RuleOperator; value?: string | number | [number, number];
  target?: "all" | "any" | "keeper" | "trash";
};
export type KeeperPreference = {
  field: "directory" | "fileSize" | "pixelCount" | "takenAt" | "fileModifiedAt";
  direction: "highest" | "lowest";
  /** First directory wins; paths are case-sensitive and boundary-aware. */
  directories?: string[];
};
export type ConfigurableRule = {
  id: string; name: string; enabled: boolean; action: "include" | "exclude";
  comparison: "checksum" | "metadata"; acknowledgeHeuristic: boolean;
  conditions: RuleCondition; keeperPreferences: KeeperPreference[];
};
export type RuleSetDraft = { schemaVersion: 1; rules: ConfigurableRule[] };
export type RuleSet = RuleSetDraft & { revision: string; engineVersion: "1" };
export type RuleMetadata = Record<string, string | number | null>;
export type RuleAsset = AssetRecord & { ruleMetadata?: RuleMetadata };
export type ConfiguredDecision = DuplicateDecision & {
  rulesetRevision: string; engineVersion: "1";
  evidenceClass: "checksum" | "metadata" | "unverified";
  outcome: "eligible" | "excluded" | "deferred";
  requiredFields: string[]; missingFields: string[];
  /** Canonical dependency evidence, not an execution authorization. */
  dependencyFingerprint: string;
  observedValues: Record<string, Array<string | number | boolean | null>>;
};
export type RulesState = { active: RuleSet; draft: RuleSetDraft; presets: ConfigurableRule[] };
