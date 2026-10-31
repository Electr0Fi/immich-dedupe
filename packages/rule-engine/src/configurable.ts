import { RULE_FIELDS } from "@immich-dedupe/shared";
import type { ConfigurableRule, ConfiguredDecision, DuplicateGroup, KeeperPreference, RuleAsset, RuleCondition, RuleField, RuleSet, RuleSetDraft } from "@immich-dedupe/shared";

export const RULE_ENGINE_VERSION = "1" as const;
const numericFields = new Set(["fileSize", "width", "height", "pixelCount", "aspectRatio", "exif.orientation", "exif.fNumber", "exif.iso", "exif.rating"]);
const dateFields = new Set(["takenAt", "fileCreatedAt", "fileModifiedAt"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown rules configuration property"); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 1024; }

/** Pure bounded validation; the API exposes this through its Zod schema. */
export function assertRuleSetDraft(value: unknown): asserts value is RuleSetDraft {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.rules) || value.rules.length > 50) throw new Error("Expected schemaVersion 1 and at most 50 rules");
  keys(value, ["schemaVersion", "rules"]);
  const ids = new Set<string>();
  let nodes = 0;
  function condition(value: unknown, depth = 0): void {
    if (!object(value) || depth > 4 || ++nodes > 500) throw new Error("Conditions exceed the depth or count limit");
    if (own(value, "all") || own(value, "any")) {
      const key = own(value, "all") ? "all" : "any";
      keys(value, [key]);
      if (!Array.isArray(value[key]) || value[key].length > 32) throw new Error("Condition groups allow at most 32 children");
      for (const child of value[key]) condition(child, depth + 1);
      return;
    }
    keys(value, ["field", "operator", "value", "target"]);
    if (!RULE_FIELDS.includes(value.field as RuleField)) throw new Error("Unsupported rule field");
    const field = value.field as RuleField;
    const operators = ["same", "different", "eq", "ne", "gt", "gte", "lt", "lte", "between", "prefix", "glob", "missing", "within"];
    if (!operators.includes(String(value.operator))) throw new Error("Unsupported condition operator");
    if (["gt", "gte", "lt", "lte"].includes(String(value.operator)) && !numericFields.has(field) && !dateFields.has(field)) throw new Error("Ordering comparisons require a numeric or date field");
    if (value.target !== undefined && !["all", "any", "keeper", "trash"].includes(String(value.target))) throw new Error("Unsupported condition target");
    if (["same", "different", "missing"].includes(String(value.operator))) {
      if (value.value !== undefined) throw new Error("Pair and missing operators do not take a value");
    } else if (value.operator === "within") {
      if (!dateFields.has(field) || typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) throw new Error("Date tolerance must be a nonnegative number of seconds");
    } else if (value.operator === "between") {
      if (!numericFields.has(field) || !Array.isArray(value.value) || value.value.length !== 2 || !value.value.every((v) => typeof v === "number" && Number.isFinite(v)) || value.value[0] > value.value[1]) throw new Error("Numeric range requires ordered finite bounds");
    } else if (["prefix", "glob"].includes(String(value.operator))) {
      if (numericFields.has(field) || dateFields.has(field) || !text(value.value)) throw new Error("Text matching requires a nonempty text value");
    } else if (value.value === undefined) {
      if (!["gt", "gte", "lt", "lte"].includes(String(value.operator)) || !["keeper", "trash"].includes(String(value.target)) || (!numericFields.has(field) && !dateFields.has(field))) throw new Error("Pair ordering requires a numeric/date keeper or trash field");
    } else if (numericFields.has(field)) {
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) throw new Error("Numeric comparison requires a finite number");
    } else if (!text(value.value)) throw new Error("Text comparison requires a nonempty string");
  }
  for (const rule of value.rules) {
    if (!object(rule)) throw new Error("Invalid rule");
    keys(rule, ["id", "name", "enabled", "action", "comparison", "acknowledgeHeuristic", "conditions", "keeperPreferences"]);
    if (!text(rule.id) || !text(rule.name) || ids.has(rule.id) || typeof rule.enabled !== "boolean" || !["include", "exclude"].includes(String(rule.action)) || !["checksum", "metadata"].includes(String(rule.comparison)) || typeof rule.acknowledgeHeuristic !== "boolean") throw new Error("Rules require unique IDs, a name and valid comparison/action settings");
    ids.add(rule.id);
    if (rule.enabled && rule.action === "include" && rule.comparison === "metadata" && !rule.acknowledgeHeuristic) throw new Error("Enable heuristic acknowledgement before activating a metadata inclusion rule");
    condition(rule.conditions);
    if (!Array.isArray(rule.keeperPreferences) || rule.keeperPreferences.length > 12) throw new Error("At most 12 keeper preferences are supported");
    for (const preference of rule.keeperPreferences) {
      if (!object(preference)) throw new Error("Invalid keeper preference");
      keys(preference, ["field", "direction", "directories"]);
      if (!["directory", "fileSize", "pixelCount", "takenAt", "fileModifiedAt"].includes(String(preference.field)) || !["highest", "lowest"].includes(String(preference.direction))) throw new Error("Unsupported keeper preference");
      if (preference.field === "directory") {
        if (!Array.isArray(preference.directories) || preference.directories.length === 0 || preference.directories.length > 32 || !preference.directories.every((v) => text(v) && (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)))) throw new Error("Directory preferences require up to 32 absolute directories");
      } else if (preference.directories !== undefined) throw new Error("Directories only apply to directory preferences");
    }
  }
}

/** Stable dependency encoding deliberately retains all normalized metadata. */
export function canonicalRulesJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRulesJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonicalRulesJson(v)}`).join(",")}}`;
}

export function defaultRulePresets(): ConfigurableRule[] {
  const directories: KeeperPreference = { field: "directory", direction: "lowest", directories: ["/external", "/mnt/external", "/photos/External", "/photos/external", "/usr/src/app/upload", "/photos/internal", "/data/internal", "/data/library/admin"] };
  const sameName: RuleCondition = { field: "fileName", operator: "same" };
  return [
    { id: "identical-files", name: "Identical files — keep preferred directory", enabled: true, action: "include", comparison: "checksum", acknowledgeHeuristic: false, conditions: { all: [] }, keeperPreferences: [directories] },
    { id: "matching-metadata", name: "Matching name and dimensions — keep larger copy", enabled: false, action: "include", comparison: "metadata", acknowledgeHeuristic: false, conditions: { all: [sameName, { field: "width", operator: "same" }, { field: "height", operator: "same" }, { field: "fileSize", operator: "gt", target: "keeper" }] }, keeperPreferences: [directories] },
    { id: "resolution-variants", name: "Resolution variants — matching name and aspect ratio", enabled: false, action: "include", comparison: "metadata", acknowledgeHeuristic: false, conditions: { all: [sameName, { field: "aspectRatio", operator: "same" }, { field: "pixelCount", operator: "different" }] }, keeperPreferences: [{ field: "pixelCount", direction: "highest" }, directories] },
  ];
}
export function createDefaultRuleSetDraft(): RuleSetDraft { return { schemaVersion: 1, rules: defaultRulePresets() }; }
/** SHA-256 over UTF-8 configuration; portable and free of platform/I/O dependencies. */
function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length); buffer.set(bytes); buffer[bytes.length] = 128;
  const view = new DataView(buffer.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000)); view.setUint32(length - 4, bytes.length * 8);
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (x: number, bits: number) => (x >>> bits) | (x << (32 - bits));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+first)>>>0; d=c; c=b; b=a; a=(first+second)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, i) => { state[i] = (state[i] + value) >>> 0; });
  }
  return state.map((value) => value.toString(16).padStart(8,"0")).join("");
}
export function createRuleSet(draft: RuleSetDraft): RuleSet {
  assertRuleSetDraft(draft);
  const body = { ...structuredClone(draft), engineVersion: RULE_ENGINE_VERSION };
  return { ...body, revision: sha256(canonicalRulesJson(body)) };
}
export function validateRuleSet(value: unknown): RuleSet {
  if (!object(value) || value.engineVersion !== RULE_ENGINE_VERSION || typeof value.revision !== "string") throw new Error("Invalid ruleset revision");
  keys(value, ["schemaVersion", "rules", "engineVersion", "revision"]);
  const draft = { schemaVersion: value.schemaVersion, rules: value.rules };
  assertRuleSetDraft(draft);
  const expected = createRuleSet(draft);
  if (expected.revision !== value.revision) throw new Error("Ruleset revision does not match its immutable contents");
  return expected;
}

type Scalar = string | number | null;
type Value = Scalar | string[];
type Truth = true | false | "unknown";
function date(value: string | null): number | null {
  if (!value || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const n = Date.parse(value); return Number.isFinite(n) ? n : null;
}
export function directoryMatches(file: string, directory: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const prefix = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return prefix === "" ? normalized.startsWith("/") : normalized === prefix || normalized.startsWith(`${prefix}/`);
}
function valueOf(asset: RuleAsset, field: RuleField): Value {
  if (field.startsWith("exif.")) {
    const value = asset.ruleMetadata?.[field.slice(5)] ?? null;
    return numericFields.has(field) ? typeof value === "number" && Number.isFinite(value) ? value : null : value;
  }
  if (field === "albumId") return asset.albumsKnown === false ? null : asset.albums.map((a) => a.albumId).sort();
  if (field === "albumName") return asset.albumsKnown === false ? null : asset.albums.map((a) => a.albumName).sort();
  if (field === "fileName" || field === "fileNameStem" || field === "extension") {
    const name = asset.fileName?.trim().toLowerCase();
    if (!name) return null;
    const dot = name.lastIndexOf(".");
    return field === "fileName" ? name : field === "extension" ? dot < 0 ? "" : name.slice(dot + 1) : dot < 0 ? name : name.slice(0, dot);
  }
  if (field === "pixelCount" || field === "aspectRatio") {
    if (asset.width == null || asset.height == null || asset.width <= 0 || asset.height <= 0) return null;
    const result = field === "pixelCount" ? asset.width * asset.height : asset.width / asset.height;
    return Number.isFinite(result) && result > 0 ? result : null;
  }
  const result = asset[field as keyof RuleAsset];
  if (dateFields.has(field)) return date(typeof result === "string" ? result : null);
  if (typeof result === "number") return Number.isFinite(result) && (numericFields.has(field) ? result > 0 || field === "exif.rating" : true) ? result : null;
  return typeof result === "string" && result.trim() ? result : null;
}
function normalizedChecksum(value: string | null): string | null {
  if (value === null) return null;
  if (/^[a-fA-F0-9]{40}$/.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=$/.test(value)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let acc = 0, bits = 0, result = "";
  for (const char of value.slice(0, -1)) {
    acc = (acc << 6) | alphabet.indexOf(char); bits += 6;
    if (bits >= 8) { bits -= 8; result += ((acc >>> bits) & 255).toString(16).padStart(2, "0"); }
  }
  return result;
}
function glob(pattern: string, value: string): boolean {
  // Bounded linear wildcard matching avoids regular-expression backtracking.
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) { p++; v++; }
    else if (pattern[p] === "*") { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function evaluateConfiguredGroup(group: DuplicateGroup, ruleset: RuleSet): ConfiguredDecision {
  const assets = [...group.assets].sort((a, b) => a.id.localeCompare(b.id)) as RuleAsset[];
  const required = new Set<string>(); const missing = new Set<string>();
  const observed: ConfiguredDecision["observedValues"] = {};
  let matched: ConfigurableRule | null = null;
  let evidenceClass: ConfiguredDecision["evidenceClass"] = "unverified";
  const fingerprint = canonicalRulesJson({ revision: ruleset.revision, groupId: group.groupId, assets: [...assets].sort((a, b) => a.id.localeCompare(b.id)).map((a) => ({ ...a, albums: [...a.albums].sort((a, b) => a.albumId.localeCompare(b.albumId)) })) });
  function finish(outcome: ConfiguredDecision["outcome"], reasons: string[], keeper?: RuleAsset): ConfiguredDecision {
    return { groupId: group.groupId, status: outcome === "eligible" ? "auto-resolve" : outcome === "deferred" ? "uncertain" : "skip", keepAssetId: keeper?.id ?? null, trashAssetIds: keeper ? assets.filter((a) => a.id !== keeper.id).map((a) => a.id) : [], confidence: outcome === "eligible" ? 100 : 0, matchedRuleId: matched?.id ?? null, matchedRuleName: matched?.name ?? null, reasons, rulesetRevision: ruleset.revision, engineVersion: RULE_ENGINE_VERSION, evidenceClass, outcome, requiredFields: [...required].sort(), missingFields: outcome === "eligible" ? [] : [...missing].sort(), dependencyFingerprint: fingerprint, observedValues: observed };
  }
  if (assets.length !== 2) return finish("excluded", [`${assets.length} assets in group; current rule definitions only support exactly 2 assets per group.`]);
  if (assets[0].id === assets[1].id || assets.some((a) => !a.id || a.duplicateId !== group.groupId)) return finish("excluded", ["Group must contain two distinct assets with consistent duplicate membership"]);
  for (const asset of assets) {
    if (asset.ruleMetadata?.missingLivePhotoLink === 1) missing.add(`${asset.id}.livePhotoVideoId`);
    for (const field of ["assetType", "isEdited", "isTrashed", "isFavorite", "isArchived", "isOffline", "livePhotoVideoId"] as const) {
      required.add(field);
      const v = asset[field];
      if (field === "assetType" ? v == null : field === "livePhotoVideoId" ? v === undefined : v == null) missing.add(`${asset.id}.${field}`);
      else if (field === "assetType" ? v !== "IMAGE" : field === "livePhotoVideoId" ? v !== null : v !== false) return finish("excluded", [`Protected or unsupported asset: ${field}; only unlinked, unedited, untrashed, online images without favorite/archive flags are supported`]);
    }
  }
  if (missing.size) return finish("deferred", ["Complete safety metadata is required", ...missing]);
  for (const asset of assets) {
    for (const field of ["fileName", "originalPath", "fileSize", "width", "height"] as const) {
      required.add(field);
      if (valueOf(asset, field) === null) missing.add(`${asset.id}.${field}`);
    }
  }
  if (missing.size) return finish("deferred", ["Known filenames, paths, positive file sizes and dimensions are required", ...missing]);
  function read(asset: RuleAsset, field: RuleField): Value {
    required.add(field);
    const value = valueOf(asset, field);
    observed[field] = assets.map((a) => { const v = valueOf(a, field); return Array.isArray(v) ? v.join(", ") : v; });
    if (value === null) missing.add(`${asset.id}.${field}`);
    return value;
  }
  function keeper(rule: ConfigurableRule): { asset?: RuleAsset; unknown?: boolean } {
    for (const preference of rule.keeperPreferences) {
      let a: number | null, b: number | null;
      if (preference.field === "directory") {
        const paths = assets.map((asset) => read(asset, "originalPath"));
        if (paths.some((v) => v === null)) return { unknown: true };
        const ranks = paths.map((v) => preference.directories!.findIndex((directory) => directoryMatches(v as string, directory)));
        [a, b] = ranks.map((v) => v < 0 ? Number.MAX_SAFE_INTEGER : v);
      } else {
        const field = preference.field;
        [a, b] = assets.map((asset) => read(asset, field)) as [number | null, number | null];
        if (a === null || b === null) return { unknown: true };
      }
      if (a !== b) return { asset: assets[preference.field !== "directory" && preference.direction === "highest" ? a! > b! ? 0 : 1 : a! < b! ? 0 : 1] };
    }
    return {};
  }
  function condition(node: RuleCondition, keep?: RuleAsset): Truth {
    if ("all" in node || "any" in node) {
      const all = "all" in node; const values = (all ? node.all : node.any).map((child) => condition(child, keep));
      return all ? values.includes(false) ? false : values.includes("unknown") ? "unknown" : true : values.includes(true) ? true : values.includes("unknown") ? "unknown" : false;
    }
    const values = assets.map((a) => read(a, node.field));
    if (node.operator === "missing") return values.some((v) => v === null);
    if (values.includes(null)) return "unknown";
    if (node.operator === "same" || node.operator === "different") {
      const same = canonicalRulesJson(values[0]) === canonicalRulesJson(values[1]); return node.operator === "same" ? same : !same;
    }
    if (node.operator === "within") return Math.abs((values[0] as number) - (values[1] as number)) <= (node.value as number) * 1000;
    const indices = node.target === "keeper" || node.target === "trash" ? keep ? [assets.findIndex((a) => node.target === "keeper" ? a.id === keep.id : a.id !== keep.id)] : [] : [0, 1];
    if (!indices.length) return "unknown";
    const leaf = node;
    function compare(actual: Value, expected: Value): boolean {
      if (Array.isArray(actual)) return leaf.operator === "ne" ? actual.every((v) => v !== expected) : actual.some((v) => compare(v, expected));
      if (leaf.operator === "eq" || leaf.operator === "ne") {
        const normalized = leaf.field === "fileName" || leaf.field === "fileNameStem" || leaf.field === "extension" ? String(expected).trim().toLowerCase() : expected;
        return leaf.operator === "eq" ? actual === normalized : actual !== normalized;
      }
      if (leaf.operator === "prefix") return typeof actual === "string" && (leaf.field === "originalPath" ? directoryMatches(actual, String(expected)) : actual.startsWith(String(expected)));
      if (leaf.operator === "glob") return typeof actual === "string" && glob(String(expected), actual);
      if (leaf.operator === "between") return typeof actual === "number" && actual >= (leaf.value as [number, number])[0] && actual <= (leaf.value as [number, number])[1];
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      return leaf.operator === "gt" ? actual > expected : leaf.operator === "gte" ? actual >= expected : leaf.operator === "lt" ? actual < expected : actual <= expected;
    }
    const expected = dateFields.has(node.field) && typeof node.value === "string" ? date(node.value) : node.value;
    if (expected === null) return "unknown";
    const matches = indices.map((index) => compare(values[index], expected === undefined ? values[1 - index] : Array.isArray(expected) ? null : expected));
    return node.target === "any" ? matches.some(Boolean) : matches.every(Boolean);
  }
  for (const rule of ruleset.rules) {
    if (!rule.enabled) continue;
    missing.clear();
    const needsKeeper = canonicalRulesJson(rule.conditions).includes('"target":"keeper"') || canonicalRulesJson(rule.conditions).includes('"target":"trash"');
    const selected = needsKeeper ? keeper(rule) : {};
    const result = condition(rule.conditions, selected.asset);
    if (result === false) continue;
    matched = rule;
    if (result === "unknown") return finish("deferred", [`Cannot determine whether rule “${rule.name}” matches`, ...missing]);
    if (rule.action === "exclude") return finish("excluded", [`Excluded by rule “${rule.name}”`]);
    if (rule.comparison === "metadata" && !rule.acknowledgeHeuristic) return finish("excluded", ["Metadata inclusion requires explicit heuristic acknowledgement"]);
    if (rule.comparison === "checksum") {
      const hashes = assets.map((a) => normalizedChecksum(read(a, "checksum") as string | null));
      if (hashes.some((h) => h === null)) { assets.forEach((a, i) => { if (hashes[i] === null) missing.add(`${a.id}.checksum`); }); return finish("deferred", ["Valid Immich checksums are required", ...missing]); }
      if (hashes[0] !== hashes[1]) { matched = null; continue; }
      const sizes = assets.map((a) => read(a, "fileSize"));
      if (sizes.includes(null)) return finish("deferred", ["Known positive sizes are required to check checksum consistency", ...missing]);
      if (sizes[0] !== sizes[1]) return finish("excluded", ["Matching checksums conflict with different file sizes; evidence is inconsistent"]);
      for (const field of ["width", "height"] as const) {
        const values = assets.map((a) => valueOf(a, field));
        if (values.every((v) => v !== null) && values[0] !== values[1]) return finish("excluded", ["Matching checksums conflict with different dimensions; evidence is inconsistent"]);
      }
      evidenceClass = "checksum";
    } else evidenceClass = "metadata";
    const selection = needsKeeper ? selected : keeper(rule);
    if (!selection.asset) return finish(selection.unknown ? "deferred" : "excluded", [selection.unknown ? "Keeper preference metadata is missing" : "Keeper preferences are tied; no automatic choice can be made", ...missing]);
    return finish("eligible", [`Included by rule “${rule.name}”`, evidenceClass === "checksum" ? "Checksum match: matching stored Immich checksums and consistent file sizes; originals were not downloaded" : "Metadata match: this heuristic does not prove identical image content", "Keeper selected using configured directory/metadata preferences"], selection.asset);
  }
  matched = null;
  return finish("excluded", ["No enabled inclusion rule matched; AI similarity alone never qualifies a group"]);
}
