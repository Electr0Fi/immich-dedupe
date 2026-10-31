import fs from "node:fs";
import { z } from "zod";
import type { ExecutionScope, RuleSet, RuleSetDraft, RulesState } from "@immich-dedupe/shared";
import { assertRuleSetDraft, createDefaultRuleSetDraft, createRuleSet, defaultRulePresets, validateRuleSet } from "@immich-dedupe/rule-engine";
import { writeAtomicJson, type JournalFs } from "./atomicJson";

export const ruleSetDraftSchema = z.unknown().transform((value, context): RuleSetDraft => {
  try { assertRuleSetDraft(value); return structuredClone(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid ruleset" }); return z.NEVER; }
});
export const ruleSetSchema = z.unknown().transform((value, context): RuleSet => {
  try { return validateRuleSet(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid ruleset revision" }); return z.NEVER; }
});
const scopeSchema = z.object({ apiUrl: z.string().url(), accountId: z.string().min(1) }).strict();
const entrySchema = z.object({ scope: scopeSchema, activeRevision: z.string().regex(/^[a-f0-9]{64}$/), draft: ruleSetDraftSchema, revisions: z.array(ruleSetSchema).nonempty() }).strict().superRefine((entry, context) => {
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
      const draft = createDefaultRuleSetDraft(); const active = createRuleSet(draft);
      found = { scope: normalizeScope(scope), activeRevision: active.revision, draft, revisions: [active] };
      store.scopes.push(found);
    }
    return found;
  }
  function view(value: ReturnType<typeof entry>): RulesState {
    return structuredClone({ active: value.revisions.find((r) => r.revision === value.activeRevision)!, draft: value.draft, presets: defaultRulePresets() });
  }
  function commit(next: PersistedRules): void {
    storeSchema.parse(next);
    try { if (options.filePath) writeAtomicJson(options.filePath, next, io); }
    catch { throw new RulesStoreError("Rules configuration could not be saved; no new rules have been activated"); }
    loaded = next;
  }
  return {
    async get(scope: ExecutionScope): Promise<RulesState> { return view(entry(load(), scope)); },
    async saveDraft(scope: ExecutionScope, draft: RuleSetDraft): Promise<RulesState> {
      const parsed = ruleSetDraftSchema.parse(draft);
      const next = structuredClone(load()); const current = entry(next, scope);
      current.draft = parsed; commit(next); return view(current);
    },
    async publish(scope: ExecutionScope, draft?: RuleSetDraft, expectedRevision?: string): Promise<RulesState> {
      const next = structuredClone(load()); const current = entry(next, scope);
      if (expectedRevision !== undefined && current.activeRevision !== expectedRevision) throw new RulesStoreError("Active rules changed; reload the rules before publishing", 409);
      const parsed = ruleSetDraftSchema.parse(draft ?? current.draft); const revision = createRuleSet(parsed);
      if (!current.revisions.some((r) => r.revision === revision.revision)) current.revisions.push(revision);
      current.activeRevision = revision.revision; current.draft = parsed;
      commit(next); return view(current);
    },
  };
}
export type RulesStore = ReturnType<typeof createRulesStore>;
