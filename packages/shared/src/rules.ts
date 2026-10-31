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
  resolution?: ResolutionCondition;
};
export type ResolutionCondition = { all: ResolutionCondition[] } | { any: ResolutionCondition[] } |
  { field: RuleField; operator: RuleOperator; value?: string | number | [number, number]; compareTo?: "other"; includeSubdirectories?: boolean } |
  { preference: KeeperPreference; operator: "better" | "tied" };
export type ResolutionAssessment = {
  status: "matched" | "no-match" | "ambiguous" | "unverified";
  assets: Array<{ id: string; fileName: string; path: string | null; fileSize: number | null; width: number | null; height: number | null;
    matches: boolean | null; requirements: Array<{ description: string; matches: boolean | null }> }>;
};
export type RuleSetDraft = { schemaVersion: 1 | 2; rules: ConfigurableRule[] };
/** Convert typed editor state without discarding new requirements entered during
 * a hot reload. Callers must still validate before publishing or persisting. */
export function upgradeResolutionDraft(draft: RuleSetDraft): RuleSetDraft {
  if (draft.schemaVersion === 2) return structuredClone(draft);
  return { schemaVersion: 2, rules: draft.rules.map((rule) => ({ ...structuredClone(rule), keeperPreferences: [],
    resolution: rule.resolution ? structuredClone(rule.resolution) : { any: rule.keeperPreferences.map((preference, index) => ({ all: [
      ...rule.keeperPreferences.slice(0, index).map((previous): ResolutionCondition => ({ preference: structuredClone(previous), operator: 'tied' })),
      { preference: structuredClone(preference), operator: 'better' as const },
    ] })) },
  })) };
}
export type RuleSet = RuleSetDraft & { revision: string; engineVersion: "1" | "2" };
export type RuleMetadata = Record<string, string | number | null>;
export type RuleAsset = AssetRecord & { ruleMetadata?: RuleMetadata };
export type ConfiguredDecision = DuplicateDecision & {
  rulesetRevision: string; engineVersion: "1" | "2";
  resolution?: ResolutionAssessment;
  evidenceClass: "checksum" | "metadata" | "unverified";
  outcome: "eligible" | "excluded" | "deferred";
  requiredFields: string[]; missingFields: string[];
  /** Canonical dependency evidence, not an execution authorization. */
  dependencyFingerprint: string;
  observedValues: Record<string, Array<string | number | boolean | null>>;
};
/** A named copy of an entire editor configuration; saving never publishes rules. */
export type RulePreset = { id: string; name: string; ruleset: RuleSetDraft; revision: number };
export type SaveRulePresetRequest = { name: string; ruleset: RuleSetDraft; overwriteId?: string; expectedRevision?: number };
export type RulesState = { active: RuleSet; draft: RuleSetDraft; presets: ConfigurableRule[]; savedPresets: RulePreset[]; requiresResolutionUpgrade?: boolean };
