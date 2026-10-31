import { RULE_FIELDS, upgradeResolutionDraft } from '@immich-dedupe/shared';
import type { ConfigurableRule, ConfiguredDecision, DuplicateGroup, KeeperPreference, ResolutionAssessment, ResolutionCondition, RuleAsset, RuleCondition, RuleField, RuleSet, RuleSetDraft } from '@immich-dedupe/shared';
import * as historical from './configurableV1';
export { canonicalRulesJson, directoryMatches, defaultRulePresets, createDefaultRuleSetDraft } from './configurableV1';
export const RULE_ENGINE_VERSION = '2' as const;
const numeric = new Set(['fileSize', 'width', 'height', 'pixelCount', 'aspectRatio', 'exif.orientation', 'exif.fNumber', 'exif.iso', 'exif.rating']);
const dates = new Set(['takenAt', 'fileCreatedAt', 'fileModifiedAt']);
const fieldLabels: Partial<Record<RuleField,string>> = { originalPath: 'Directory', fileSize: 'File size (bytes)', pixelCount: 'Resolution (pixel count)', width: 'Width', height: 'Height', takenAt: 'Capture date', fileModifiedAt: 'Modified date', fileName: 'Filename' };
const operatorLabels: Record<string,string> = { gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most', eq: 'equals', ne: 'does not equal', prefix: 'is within', glob: 'matches', between: 'is between', missing: 'is missing', same: 'equals', different: 'differs from', within: 'is within the time tolerance of' };
type Truth = boolean | null;
type Value = string | number | string[] | null;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function combine(values: Truth[], all: boolean): Truth { return all ? values.includes(false) ? false : values.includes(null) ? null : true : values.includes(true) ? true : values.includes(null) ? null : false; }
function checkPreference(preference: unknown) {
  historical.assertRuleSetDraft({ schemaVersion: 1, rules: [{ id: 'validation', name: 'validation', enabled: false, action: 'include', comparison: 'checksum', acknowledgeHeuristic: false, conditions: { all: [] }, keeperPreferences: [preference] }] });
}
export function assertRuleSetDraft(value: unknown): asserts value is RuleSetDraft {
  if (record(value) && value.schemaVersion === 1) { historical.assertRuleSetDraft(value); return; }
  if (!record(value) || value.schemaVersion !== 2 || !Array.isArray(value.rules)) throw new Error('Expected rule schemaVersion 1 or 2');
  if (Object.keys(value).some((key) => !['schemaVersion', 'rules'].includes(key))) throw new Error('Unknown rules configuration property');
  historical.assertRuleSetDraft({ schemaVersion: 1, rules: value.rules.map((rule: unknown) => {
    if (!record(rule)) throw new Error('Invalid rule');
    const { resolution: _resolution, ...legacy } = rule;
    return legacy;
  }) });
  let nodes = 0;
  function condition(node: unknown, depth = 0): void {
    if (!record(node) || depth > 4 || ++nodes > 20000) throw new Error('Resolution conditions exceed the depth or count limit');
    if ('all' in node || 'any' in node) {
      const key = 'all' in node ? 'all' : 'any';
      if (Object.keys(node).length !== 1 || !Array.isArray(node[key]) || node[key].length > 32) throw new Error('Invalid resolution condition group');
      node[key].forEach((child) => condition(child, depth + 1)); return;
    }
    if ('preference' in node) {
      if (Object.keys(node).some((key) => !['preference', 'operator'].includes(key)) || !['better', 'tied'].includes(String(node.operator))) throw new Error('Invalid relative preference comparison');
      checkPreference(node.preference); return;
    }
    if (Object.keys(node).some((key) => !['field', 'operator', 'value', 'compareTo', 'includeSubdirectories'].includes(key)) || !RULE_FIELDS.includes(node.field as RuleField)) throw new Error('Invalid resolution condition');
    if (node.compareTo !== undefined && node.compareTo !== 'other') throw new Error('Invalid comparison asset');
    if (node.includeSubdirectories !== undefined && (typeof node.includeSubdirectories !== 'boolean' || node.field !== 'originalPath' || node.operator !== 'prefix')) throw new Error('Subdirectory option requires directory matching');
    if (node.compareTo === 'other' && (node.value !== undefined || !['eq','ne','gt','gte','lt','lte'].includes(String(node.operator)))) throw new Error('Comparison with the other asset cannot also have a literal value');
    // Reuse the typed Stage 1 validator; pair equality has no literal value.
    const operator = node.compareTo === 'other' && ['eq','ne'].includes(String(node.operator)) ? node.operator === 'eq' ? 'same' : 'different' : node.operator;
    historical.assertRuleSetDraft({ schemaVersion: 1, rules: [{ id: 'validation', name: 'validation', enabled: false, action: 'include', comparison: 'checksum', acknowledgeHeuristic: false,
      conditions: { field: node.field, operator, ...(node.value === undefined ? {} : { value: node.value }), ...(node.compareTo === 'other' && !['same','different'].includes(String(operator)) ? { target: 'keeper' } : {}) }, keeperPreferences: [] }] });
  }
  for (const rule of value.rules) {
    if (!record(rule) || !Array.isArray(rule.keeperPreferences) || rule.keeperPreferences.length) throw new Error('Version 2 uses resolution requirements instead of ordered keeper preferences');
    condition(rule.resolution);
  }
}
export function upgradeRuleSetDraft(draft: RuleSetDraft): RuleSetDraft {
  assertRuleSetDraft(draft);
  return upgradeResolutionDraft(draft);
}
export function currentRulePresets(): ConfigurableRule[] { return upgradeRuleSetDraft(historical.createDefaultRuleSetDraft()).rules; }
export function createCurrentRuleSetDraft(): RuleSetDraft { return { schemaVersion: 2, rules: currentRulePresets() }; }
export function createRuleSet(draft: RuleSetDraft): RuleSet {
  assertRuleSetDraft(draft);
  if (draft.schemaVersion === 1) return historical.createRuleSet(draft);
  // Reuse the frozen portable SHA-256 implementation through its exported digest helper.
  const body = { ...structuredClone(draft), engineVersion: '2' as const };
  return { ...body, revision: historical.ruleDigest(historical.canonicalRulesJson(body)) };
}
export function validateRuleSet(value: unknown): RuleSet {
  if (record(value) && value.engineVersion === '1') return historical.validateRuleSet(value);
  if (!record(value) || value.engineVersion !== '2' || Object.keys(value).some((key) => !['schemaVersion','rules','engineVersion','revision'].includes(key))) throw new Error('Invalid ruleset revision');
  const draft = { schemaVersion: value.schemaVersion, rules: value.rules }; assertRuleSetDraft(draft);
  if (draft.schemaVersion !== 2) throw new Error('Engine and schema versions differ');
  const expected = createRuleSet(draft); if (expected.revision !== value.revision) throw new Error('Ruleset revision does not match its immutable contents'); return expected;
}
function compare(actual: Value, expected: Value, operator: string, field: RuleField, includeSubdirectories = true): Truth {
  if (actual === null || expected === null) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const same = historical.canonicalRulesJson(actual) === historical.canonicalRulesJson(expected);
    return ['eq', 'same'].includes(operator) ? same : ['ne', 'different'].includes(operator) ? !same : false;
  }
  if (Array.isArray(actual)) return operator === 'ne' ? actual.every((v) => compare(v, expected, 'ne', field) === true) : actual.some((v) => compare(v, expected, operator, field) === true);
  if (Array.isArray(expected)) return false;
  const normalized = ['fileName','fileNameStem','extension'].includes(field) && typeof expected === 'string' ? expected.trim().toLowerCase() : expected;
  if (operator === 'eq' || operator === 'same') return actual === normalized;
  if (operator === 'ne' || operator === 'different') return actual !== normalized;
  if (operator === 'prefix') {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    if (field !== 'originalPath') return actual.startsWith(expected);
    if (includeSubdirectories) return historical.directoryMatches(actual, expected);
    const directory = actual.replace(/\\/g, '/').slice(0, actual.replace(/\\/g, '/').lastIndexOf('/')) || '/';
    return directory.replace(/\/+$/, '') === expected.replace(/\\/g, '/').replace(/\/+$/, '');
  }
  if (operator === 'glob') return typeof actual === 'string' && historical.glob(String(expected), actual);
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  return operator === 'gt' ? actual > expected : operator === 'gte' ? actual >= expected : operator === 'lt' ? actual < expected : operator === 'lte' ? actual <= expected : false;
}
function literal(field: RuleField, value: string | number | undefined): Value {
  if (dates.has(field) && typeof value === 'string') {
    const parsed = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null;
  }
  return value ?? null;
}
export function evaluateConfiguredGroup(group: DuplicateGroup, ruleset: RuleSet): ConfiguredDecision {
  if (ruleset.engineVersion === '1') return historical.evaluateConfiguredGroup(group, ruleset);
  const assets = [...group.assets].sort((a,b) => a.id.localeCompare(b.id)) as RuleAsset[];
  const required = new Set<string>(), missing = new Set<string>();
  const observed: ConfiguredDecision['observedValues'] = {};
  let matched: ConfigurableRule | undefined, resolution: ResolutionAssessment | undefined;
  let evidenceClass: ConfiguredDecision['evidenceClass'] = 'unverified';
  const fingerprint = historical.canonicalRulesJson({ revision: ruleset.revision, groupId: group.groupId, assets: assets.map((asset) => ({ ...asset, albums: [...asset.albums].sort((a,b) => a.albumId.localeCompare(b.albumId)) })) });
  function finish(outcome: ConfiguredDecision['outcome'], reasons: string[], keeper?: RuleAsset): ConfiguredDecision {
    return { groupId: group.groupId, status: outcome === 'eligible' ? 'auto-resolve' : outcome === 'deferred' ? 'uncertain' : 'skip', keepAssetId: keeper?.id ?? null, trashAssetIds: keeper ? assets.filter((a) => a.id !== keeper.id).map((a) => a.id) : [], confidence: outcome === 'eligible' ? 100 : 0,
      matchedRuleId: matched?.id ?? null, matchedRuleName: matched?.name ?? null, reasons, rulesetRevision: ruleset.revision, engineVersion: '2', evidenceClass, outcome,
      requiredFields: [...required].sort(), missingFields: outcome === 'eligible' ? [] : [...missing].sort(), dependencyFingerprint: fingerprint, observedValues: observed, ...(resolution ? { resolution } : {}) };
  }
  function read(asset: RuleAsset, field: RuleField): Value {
    required.add(field); const value = historical.valueOf(asset, field);
    observed[field] = assets.map((a) => { const v = historical.valueOf(a, field); return Array.isArray(v) ? v.join(', ') : v; });
    if (value === null) missing.add(`${asset.id}.${field}`); return value;
  }
  if (assets.length !== 2) return finish('excluded', [`${assets.length} assets in group; current rule definitions only support exactly 2 assets per group.`]);
  if (assets[0].id === assets[1].id || assets.some((a) => !a.id || a.duplicateId !== group.groupId)) return finish('excluded', ['Group must contain two distinct assets with consistent duplicate membership']);
  for (const asset of assets) {
    if (asset.ruleMetadata?.missingLivePhotoLink === 1) missing.add(`${asset.id}.livePhotoVideoId`);
    for (const field of ['assetType','isEdited','isTrashed','isFavorite','isArchived','isOffline','livePhotoVideoId'] as const) {
      required.add(field); const v = asset[field];
      if (field === 'assetType' ? v == null : field === 'livePhotoVideoId' ? v === undefined : v == null) missing.add(`${asset.id}.${field}`);
      else if (field === 'assetType' ? v !== 'IMAGE' : field === 'livePhotoVideoId' ? v !== null : v !== false) return finish('excluded', [`Protected or unsupported asset: ${field}`]);
    }
    for (const field of ['fileName','originalPath','fileSize','width','height'] as const) if (read(asset, field) === null) missing.add(`${asset.id}.${field}`);
  }
  if (missing.size) return finish('deferred', ['Complete safety metadata, filenames, paths, positive sizes and dimensions are required', ...missing]);
  function relative(preference: KeeperPreference, asset: RuleAsset): number | null {
    if (preference.field !== 'directory') return read(asset, preference.field) as number | null;
    const path = read(asset, 'originalPath'); if (typeof path !== 'string') return null;
    const rank = preference.directories!.findIndex((directory) => historical.directoryMatches(path, directory)); return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
  }
  function assess(node: ResolutionCondition, asset: RuleAsset, other: RuleAsset, requirements: ResolutionAssessment['assets'][number]['requirements']): Truth {
    if ('all' in node) return combine(node.all.map((child) => assess(child,asset,other,requirements)), true);
    if ('any' in node) return combine(node.any.map((child) => assess(child,asset,other,requirements)), false);
    let result: Truth, description: string;
    if ('preference' in node) {
      const a = relative(node.preference,asset), b = relative(node.preference,other);
      result = a === null || b === null ? null : node.operator === 'tied' ? a === b : node.preference.field !== 'directory' && node.preference.direction === 'highest' ? a > b : a < b;
      description = `${node.preference.field === 'directory' ? `Directory priority (${node.preference.directories!.join(', ')})` : fieldLabels[node.preference.field] ?? node.preference.field}: ${node.operator === 'tied' ? 'tied with' : node.preference.field === 'directory' ? 'ranks better than' : node.preference.direction === 'highest' ? 'higher than' : 'lower than'} the other asset`;
    } else {
      const a = read(asset,node.field);
      description = `${fieldLabels[node.field] ?? node.field} ${operatorLabels[node.operator]} ${node.compareTo === 'other' || ['same','different','within'].includes(node.operator) ? 'the other asset' : Array.isArray(node.value) ? node.value.join(' and ') : node.value ?? ''}${node.field === 'originalPath' && node.operator === 'prefix' ? node.includeSubdirectories === false ? ' (this directory only)' : ' (including subdirectories)' : ''}`;
      if (node.operator === 'missing') result = a === null;
      else if (node.operator === 'between') result = a === null ? null : typeof a === 'number' && Array.isArray(node.value) && a >= node.value[0] && a <= node.value[1];
      else if (node.operator === 'within') { const b = read(other,node.field); result = a === null || b === null ? null : Math.abs(Number(a)-Number(b)) <= Number(node.value)*1000; }
      else result = compare(a, node.compareTo === 'other' || ['same','different'].includes(node.operator) ? read(other,node.field) : literal(node.field, node.value as string | number | undefined), node.operator, node.field, node.includeSubdirectories !== false);
    }
    requirements.push({ description, matches: result }); return result;
  }
  function groupCondition(node: RuleCondition, keeper?: RuleAsset): Truth {
    if ('all' in node) return combine(node.all.map((child) => groupCondition(child,keeper)), true);
    if ('any' in node) return combine(node.any.map((child) => groupCondition(child,keeper)), false);
    const values = assets.map((asset) => read(asset,node.field));
    if (node.operator === 'missing') return values.some((v) => v === null);
    if (values.includes(null)) return null;
    if (node.operator === 'same' || node.operator === 'different') { const same = historical.canonicalRulesJson(values[0]) === historical.canonicalRulesJson(values[1]); return node.operator === 'same' ? same : !same; }
    if (node.operator === 'within') return Math.abs(Number(values[0])-Number(values[1])) <= Number(node.value)*1000;
    const indices = node.target === 'keeper' || node.target === 'trash' ? keeper ? [assets.findIndex((asset) => node.target === 'keeper' ? asset.id === keeper.id : asset.id !== keeper.id)] : [] : [0,1];
    if (!indices.length) return null;
    return combine(indices.map((index) => node.operator === 'between' ? typeof values[index] === 'number' && Array.isArray(node.value) && values[index] >= node.value[0] && values[index] <= node.value[1] : compare(values[index], node.value === undefined ? values[1-index] : literal(node.field,node.value as string | number), node.operator,node.field)), node.target !== 'any');
  }
  for (const rule of ruleset.rules) {
    if (!rule.enabled) continue;
    missing.clear(); resolution = undefined; evidenceClass = 'unverified'; matched = undefined;
    const assetResults = assets.map((asset,index) => {
      const requirements: ResolutionAssessment['assets'][number]['requirements'] = [];
      const matches = assess(rule.resolution!,asset,assets[1-index],requirements);
      return { id: asset.id, fileName: asset.fileName, path: asset.originalPath, fileSize: asset.fileSize, width: asset.width, height: asset.height, matches, requirements };
    });
    const winners = assetResults.filter((asset) => asset.matches === true);
    const unknown = assetResults.some((asset) => asset.matches === null);
    const keeper = !unknown && winners.length === 1 ? assets.find((asset) => asset.id === winners[0].id) : undefined;
    const hasKeeperCondition = historical.canonicalRulesJson(rule.conditions).includes('"target":"keeper"') || historical.canonicalRulesJson(rule.conditions).includes('"target":"trash"');
    const conditionResult = hasKeeperCondition && !keeper ? combine(assets.map((asset) => groupCondition(rule.conditions,asset)), false) : groupCondition(rule.conditions,keeper);
    if (conditionResult === false) continue;
    matched = rule;
    if (conditionResult === null) return finish('deferred', [`Cannot determine whether rule “${rule.name}” matches`, ...missing]);
    if (rule.action === 'exclude') return finish('excluded', [`Excluded by rule “${rule.name}”`]);
    if (rule.comparison === 'metadata' && !rule.acknowledgeHeuristic) return finish('excluded', ['Metadata inclusion requires explicit heuristic acknowledgement']);
    if (rule.comparison === 'checksum') {
      const hashes = assets.map((asset) => historical.normalizedChecksum(read(asset,'checksum') as string | null));
      if (hashes.includes(null)) return finish('deferred', ['Valid Immich checksums are required']);
      if (hashes[0] !== hashes[1]) continue;
      if (assets[0].fileSize !== assets[1].fileSize || assets[0].width !== assets[1].width || assets[0].height !== assets[1].height) return finish('excluded', ['Matching checksums conflict with sizes or dimensions; evidence is inconsistent']);
      evidenceClass = 'checksum';
    } else evidenceClass = 'metadata';
    resolution = { status: unknown ? 'unverified' : winners.length === 1 ? 'matched' : winners.length === 0 ? 'no-match' : 'ambiguous', assets: assetResults };
    if (!keeper) return finish(unknown ? 'deferred' : 'excluded', [unknown ? 'Resolution is unverified: missing metadata prevents a unique keeper' : winners.length === 0 ? 'Resolution conflict: no asset meets all resolution requirements' : 'Resolution conflict: both assets meet the requirements; keeper selection is ambiguous', ...missing]);
    return finish('eligible', [`Included by rule “${rule.name}”`, evidenceClass === 'checksum' ? 'Checksum match: stored Immich checksums match; originals were not downloaded' : 'Metadata match: this heuristic does not prove identical content', 'Exactly one asset meets the resolution requirements'], keeper);
  }
  matched = undefined; resolution = undefined;
  return finish('excluded', ['No enabled inclusion rule matched; AI similarity alone never qualifies a group']);
}
