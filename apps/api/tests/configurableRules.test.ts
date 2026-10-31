import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AssetRecord, ConfigurableRule, DuplicateGroup, RuleSetDraft } from "@immich-dedupe/shared";
import { assertRuleSetDraft, canonicalRulesJson, createDefaultRuleSetDraft, createRuleSet, directoryMatches, evaluateConfiguredGroup, validateRuleSet } from "@immich-dedupe/rule-engine";

function asset(id: string, originalPath: string): AssetRecord {
  return { id, duplicateId: "group", fileName: "DSC_004.jpg", originalPath, originalMimeType: "image/jpeg", fileCreatedAt: "2025-01-01T00:00:00Z", fileModifiedAt: "2025-01-01T00:00:00Z", takenAt: "2025-01-01T00:00:00Z", width: 100, height: 80, checksum: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", deviceId: null, deviceAssetId: null, libraryId: null, assetType: "IMAGE", isEdited: false, isTrashed: false, isFavorite: false, isArchived: false, isOffline: false, livePhotoVideoId: null, isExternal: false, isInternal: false, fileSize: 100, albums: [], albumsKnown: true };
}
function group(): DuplicateGroup { return { groupId: "group", assets: [asset("b", "/copy/DSC_004.jpg"), asset("a", "/original/DSC_004.jpg")] }; }
function draft(): RuleSetDraft {
  const value = createDefaultRuleSetDraft();
  value.rules[0].keeperPreferences = [{ field: "directory", direction: "lowest", directories: ["/original", "/copy"] }];
  return value;
}
function metadataRule(): ConfigurableRule {
  return { id: "metadata", name: "Matching filename", action: "include", enabled: true, comparison: "metadata", acknowledgeHeuristic: true, conditions: { field: "fileName", operator: "same" }, keeperPreferences: [{ field: "directory", direction: "lowest", directories: ["/original", "/copy"] }] };
}
test("configured checksum rule supports equal-size copies in arbitrary directories and reversed list order", () => {
  const rules = createRuleSet(draft()); const input = group();
  const result = evaluateConfiguredGroup(input, rules);
  assert.equal(result.outcome, "eligible"); assert.equal(result.evidenceClass, "checksum"); assert.equal(result.keepAssetId, "a");
  assert.deepEqual(evaluateConfiguredGroup({ ...input, assets: [...input.assets].reverse() }, rules), result);
});
test("revision digest is SHA-256 of canonical rules and rejects tampering", () => {
  const rules = createRuleSet(draft()); const { revision, ...body } = rules;
  assert.equal(revision, createHash("sha256").update(canonicalRulesJson(body)).digest("hex"));
  assert.deepEqual(validateRuleSet(rules), rules);
  assert.throws(() => validateRuleSet({ ...rules, rules: [] }), /revision/);
});
test("checksum mismatch, malformed checksum and inconsistent byte evidence never qualify", () => {
  const rules = createRuleSet(draft());
  for (const checksum of ["0000000000000000000000000000000000000001", "not-a-hash", null]) {
    const input = group(); input.assets[1].checksum = checksum;
    assert.notEqual(evaluateConfiguredGroup(input, rules).outcome, "eligible");
  }
  for (const patch of [{ fileSize: 101 }, { width: 101 }]) {
    const input = group(); Object.assign(input.assets[1], patch);
    assert.match(evaluateConfiguredGroup(input, rules).reasons.join(" "), /inconsistent/);
  }
});
test("hex and base64 encodings of the same checksum compare consistently", () => {
  const input = group(); input.assets[1].checksum = "0".repeat(40);
  assert.equal(evaluateConfiguredGroup(input, createRuleSet(draft())).outcome, "eligible");
});
test("safety guards and complete executable metadata cannot be disabled by a rule", () => {
  const rules = createRuleSet({ schemaVersion: 1, rules: [metadataRule()] });
  for (const patch of [{ isFavorite: true }, { isArchived: true }, { isEdited: true }, { isOffline: true }, { isTrashed: true }, { livePhotoVideoId: "video" }, { assetType: "VIDEO" }, { isFavorite: null }, { fileSize: null }, { width: null }, { originalPath: null }, { ruleMetadata: { missingLivePhotoLink: 1 } }]) {
    const input = group(); Object.assign(input.assets[1], patch);
    assert.notEqual(evaluateConfiguredGroup(input, rules).outcome, "eligible");
  }
  const input = group(); input.assets.push(asset("c", "/copy/c.jpg"));
  assert.match(evaluateConfiguredGroup(input, rules).reasons[0], /3 assets.*exactly 2/);
});
test("heuristics need explicit acknowledgement and matching filenames reject burst neighbors", () => {
  const rule = metadataRule(); rule.acknowledgeHeuristic = false;
  assert.throws(() => createRuleSet({ schemaVersion: 1, rules: [rule] }), /acknowledgement/);
  rule.acknowledgeHeuristic = true;
  const rules = createRuleSet({ schemaVersion: 1, rules: [rule] }); const input = group();
  input.assets[0].checksum = null;
  assert.equal(evaluateConfiguredGroup(input, rules).evidenceClass, "metadata");
  input.assets[0].fileName = "DSC_005.jpg";
  assert.equal(evaluateConfiguredGroup(input, rules).outcome, "excluded");
});
test("directory preferences respect boundaries, ordering and ties", () => {
  assert.equal(directoryMatches("/originals/a.jpg", "/original"), false);
  assert.equal(directoryMatches("/original/a.jpg", "/original/"), true);
  assert.equal(directoryMatches("/Original/a.jpg", "/original"), false);
  const input = group(); input.assets[0].originalPath = "/original/b.jpg";
  assert.match(evaluateConfiguredGroup(input, createRuleSet(draft())).reasons[0], /tied/);
});
test("unknown album/EXIF values do not satisfy negative conditions or permit fallback", () => {
  const rule = metadataRule(); rule.conditions = { field: "albumName", operator: "ne", value: "Protected" };
  const input = group(); input.assets[0].albumsKnown = false;
  const rules = createRuleSet({ schemaVersion: 1, rules: [rule, { ...metadataRule(), id: "fallback" }] });
  assert.equal(evaluateConfiguredGroup(input, rules).outcome, "deferred");
  rule.conditions = { field: "exif.model", operator: "ne", value: "Camera" };
  assert.equal(evaluateConfiguredGroup(input, createRuleSet({ schemaVersion: 1, rules: [rule] })).outcome, "deferred");
});
test("bounded boolean conditions, first-match exclusions and resolution preferences", () => {
  const rule = metadataRule();
  rule.conditions = { all: [{ field: "fileName", operator: "same" }, { any: [{ field: "width", operator: "eq", value: 100 }, { field: "exif.model", operator: "eq", value: "Camera" }] }] };
  const result = evaluateConfiguredGroup(group(), createRuleSet({ schemaVersion: 1, rules: [rule] }));
  assert.equal(result.outcome, "eligible"); assert.deepEqual(result.missingFields, []);
  const exclude = { ...rule, id: "exclude", action: "exclude" as const };
  assert.equal(evaluateConfiguredGroup(group(), createRuleSet({ schemaVersion: 1, rules: [exclude, rule] })).outcome, "excluded");
  const input = group(); input.assets[1].width = 200; input.assets[1].height = 160;
  rule.conditions = { field: "aspectRatio", operator: "same" }; rule.keeperPreferences = [{ field: "pixelCount", direction: "highest" }];
  assert.equal(evaluateConfiguredGroup(input, createRuleSet({ schemaVersion: 1, rules: [rule] })).keepAssetId, "a");
});
test("date tolerances reject timezone ambiguity and numeric keeper comparisons work", () => {
  const rule = metadataRule(); rule.conditions = { all: [{ field: "takenAt", operator: "within", value: 2 }, { field: "fileSize", operator: "gt", target: "keeper" }] };
  const input = group(); input.assets[1].fileSize = 200; input.assets[1].takenAt = "2025-01-01T00:00:01Z";
  const rules = createRuleSet({ schemaVersion: 1, rules: [rule] });
  assert.equal(evaluateConfiguredGroup(input, rules).outcome, "eligible");
  input.assets[1].takenAt = "2025-01-01T00:00:01";
  assert.equal(evaluateConfiguredGroup(input, rules).outcome, "deferred");
});
test("rule validation rejects unsupported operators, injected fields and excessive nesting", () => {
  assert.throws(() => assertRuleSetDraft({ ...draft(), extra: true }));
  const rule = metadataRule(); rule.conditions = { field: "fileName", operator: "gt", value: "a" };
  assert.throws(() => createRuleSet({ schemaVersion: 1, rules: [rule] }), /numeric or date/);
  let condition = metadataRule().conditions;
  for (let i = 0; i < 6; i++) condition = { all: [condition] };
  rule.conditions = condition;
  assert.throws(() => createRuleSet({ schemaVersion: 1, rules: [rule] }), /depth/);
});
