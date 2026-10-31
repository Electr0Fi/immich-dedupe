import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExecutionScope, RuleSet, RuleSetDraft, RulesState, RulePreset, SaveRulePresetRequest } from "@immich-dedupe/shared";
import { assertRuleSetDraft, createCurrentRuleSetDraft, createRuleSet, currentRulePresets, upgradeRuleSetDraft, validateRuleSet } from "@immich-dedupe/rule-engine";
import { writeAtomicJson, type JournalFs } from "./atomicJson";

export const ruleSetDraftSchema = z.unknown().transform((value, context): RuleSetDraft => {
  try { assertRuleSetDraft(value); return structuredClone(value); }
  catch (error) {
    // Locate invalid rules without weakening validation or changing historical evaluation.
    if (value && typeof value === "object" && "schemaVersion" in value && "rules" in value && Array.isArray(value.rules)) {
      let invalid = false;
      value.rules.forEach((rule, index) => {
        try { assertRuleSetDraft({ schemaVersion: value.schemaVersion, rules: [rule] }); }
        catch (failure) {
          invalid = true;
          context.addIssue({ code: "custom", path: ["rules", index], message: `Rule ${index + 1}: ${failure instanceof Error ? failure.message : "Invalid rule"}` });
        }
      });
      if (invalid) return z.NEVER;
    }
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid ruleset" }); return z.NEVER;
  }
});
export const ruleSetSchema = z.unknown().transform((value, context): RuleSet => {
  try { return validateRuleSet(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid ruleset revision" }); return z.NEVER; }
});
const scopeSchema = z.object({ apiUrl: z.string().url(), accountId: z.string().min(1) }).strict();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const presetName = z.string().trim().min(1).max(100);
const presetKey = (name: string) => name.trim().toLowerCase();
const presetSchema = z.object({ id: z.string().uuid(), name: presetName, ruleset: ruleSetDraftSchema, revision }).strict();
export const saveRulePresetSchema = z.object({ name: presetName, ruleset: ruleSetDraftSchema,
  overwriteId: z.string().uuid().optional(), expectedRevision: revision.optional(),
}).strict().refine((request) => (request.overwriteId !== undefined) === (request.expectedRevision !== undefined), "Overwrite requires both preset ID and revision");
export const deleteRulePresetSchema = z.object({ expectedRevision: revision }).strict();
function initialPresets(): RulePreset[] {
  return [{ id: "00000000-0000-4000-8000-000000000001", name: "Default rules", ruleset: createCurrentRuleSetDraft(), revision: 1 },
    ...currentRulePresets().map((rule, index) => ({ id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
      name: rule.name, ruleset: { schemaVersion: 2 as const, rules: [rule] }, revision: 1 }))];
}
const presetListSchema = z.array(presetSchema).max(100).superRefine((presets, context) => {
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length || new Set(presets.map((preset) => presetKey(preset.name))).size !== presets.length) context.addIssue({ code: "custom", message: "Preset IDs and names must be unique" });
});
const entrySchema = z.object({ scope: scopeSchema, activeRevision: z.string().regex(/^[a-f0-9]{64}$/), draft: ruleSetDraftSchema,
  revisions: z.array(ruleSetSchema).nonempty(), savedPresets: presetListSchema.default(initialPresets),
}).strict().superRefine((entry, context) => {
  if (entry.revisions.filter((r) => r.revision === entry.activeRevision).length !== 1 || new Set(entry.revisions.map((r) => r.revision)).size !== entry.revisions.length) context.addIssue({ code: "custom", message: "Invalid immutable ruleset revision references" });
});
const storeSchema = z.object({ version: z.literal(1), scopes: z.array(entrySchema) }).strict().superRefine((store, context) => {
  const keys = store.scopes.map((entry) => scopeKey(entry.scope));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Repeated ruleset scope" });
});
type PersistedRules = z.infer<typeof storeSchema>;
export class RulesStoreError extends Error {
  constructor(message: string, public readonly status = 503) { super(message); this.name = "RulesStoreError"; }
}
function normalizeScope(scope: ExecutionScope): ExecutionScope {
  scopeSchema.parse(scope);
  const url = new URL(scope.apiUrl);
  if (url.username || url.password || url.search || url.hash) throw new RulesStoreError("Rules scope must not contain credentials or query parameters");
  return { apiUrl: url.toString().replace(/\/+$/, ""), accountId: scope.accountId };
}
function scopeKey(scope: ExecutionScope): string { const normalized = normalizeScope(scope); return JSON.stringify([normalized.apiUrl, normalized.accountId]); }

/** Lazy, injected and separate from execution/recovery authority. */
export function createRulesStore(options: { filePath?: string; io?: JournalFs; now?: () => Date } = {}) {
  const io = options.io ?? fs;
  let loaded: PersistedRules | undefined;
  function load(): PersistedRules {
    if (loaded) return loaded;
    try {
      loaded = options.filePath && io.existsSync(options.filePath) ? storeSchema.parse(JSON.parse(io.readFileSync(options.filePath, "utf8"))) : { version: 1, scopes: [] };
      return loaded;
    } catch { throw new RulesStoreError("Rules configuration is unreadable or invalid; the existing file has been preserved"); }
  }
  function entry(store: PersistedRules, scope: ExecutionScope) {
    const key = scopeKey(scope);
    let found = store.scopes.find((candidate) => scopeKey(candidate.scope) === key);
    if (!found) {
      const draft = createCurrentRuleSetDraft(); const active = createRuleSet(draft);
      found = { scope: normalizeScope(scope), activeRevision: active.revision, draft, revisions: [active], savedPresets: initialPresets() };
      store.scopes.push(found);
    }
    return found;
  }
  function view(value: ReturnType<typeof entry>): RulesState {
    return structuredClone({ active: value.revisions.find((r) => r.revision === value.activeRevision)!, draft: value.draft, presets: currentRulePresets(), savedPresets: value.savedPresets, requiresResolutionUpgrade: value.revisions.find((r) => r.revision === value.activeRevision)!.schemaVersion !== 2 });
  }
  function commit(next: PersistedRules): void {
    storeSchema.parse(next);
    try { if (options.filePath) writeAtomicJson(options.filePath, next, io); }
    catch { throw new RulesStoreError("Rules configuration could not be saved; no new rules have been activated"); }
    loaded = next;
  }
  return {
    async get(scope: ExecutionScope, upgrade = true): Promise<RulesState> {
      const current = entry(load(), scope);
      if (upgrade && (current.draft.schemaVersion === 1 || current.savedPresets.some((preset) => preset.ruleset.schemaVersion === 1))) {
        const next = structuredClone(load()), upgraded = entry(next, scope);
        upgraded.draft = upgradeRuleSetDraft(upgraded.draft);
        for (const preset of upgraded.savedPresets) if (preset.ruleset.schemaVersion === 1) { preset.ruleset = upgradeRuleSetDraft(preset.ruleset); preset.revision++; }
        commit(next); return view(upgraded);
      }
      return view(current);
    },
    async savePreset(scope: ExecutionScope, request: SaveRulePresetRequest): Promise<RulesState> {
      const parsed = saveRulePresetSchema.parse(request); parsed.ruleset = upgradeRuleSetDraft(parsed.ruleset);
      const next = structuredClone(load()), current = entry(next, scope);
      const existing = current.savedPresets.find((preset) => presetKey(preset.name) === presetKey(parsed.name));
      if (parsed.overwriteId) {
        if (!existing || existing.id !== parsed.overwriteId || existing.revision !== parsed.expectedRevision) throw new RulesStoreError("The preset changed or was deleted. Reload presets and confirm again before overwriting.", 409);
        existing.name = parsed.name; existing.ruleset = parsed.ruleset; existing.revision++;
      } else {
        if (existing) throw new RulesStoreError("A preset with this name already exists. Reload presets and confirm an overwrite.", 409);
        if (current.savedPresets.length >= 100) throw new RulesStoreError("You can save up to 100 presets. Delete an unused preset first.", 400);
        current.savedPresets.push({ id: randomUUID(), name: parsed.name, ruleset: parsed.ruleset, revision: 1 });
      }
      commit(next); return view(current);
    },
    async deletePreset(scope: ExecutionScope, id: string, expectedRevision: number): Promise<RulesState> {
      const parsed = deleteRulePresetSchema.parse({ expectedRevision });
      const next = structuredClone(load()), current = entry(next, scope);
      const existing = current.savedPresets.find((preset) => preset.id === id);
      if (!existing || existing.revision !== parsed.expectedRevision) throw new RulesStoreError("The preset changed or was deleted. Reload presets and confirm again before deleting.", 409);
      current.savedPresets = current.savedPresets.filter((preset) => preset.id !== id);
      commit(next); return view(current);
    },
    async saveDraft(scope: ExecutionScope, draft: RuleSetDraft): Promise<RulesState> {
      const parsed = upgradeRuleSetDraft(ruleSetDraftSchema.parse(draft));
      const next = structuredClone(load()); const current = entry(next, scope);
      current.draft = parsed; commit(next); return view(current);
    },
    async publish(scope: ExecutionScope, draft?: RuleSetDraft, expectedRevision?: string): Promise<RulesState> {
      const next = structuredClone(load()); const current = entry(next, scope);
      if (expectedRevision !== undefined && current.activeRevision !== expectedRevision) throw new RulesStoreError("Active rules changed; reload the rules before publishing", 409);
      const parsed = upgradeRuleSetDraft(ruleSetDraftSchema.parse(draft ?? current.draft)); const revision = createRuleSet(parsed);
      if (!current.revisions.some((r) => r.revision === revision.revision)) current.revisions.push(revision);
      current.activeRevision = revision.revision; current.draft = parsed;
      commit(next); return view(current);
    },
  };
}
export type RulesStore = ReturnType<typeof createRulesStore>;
