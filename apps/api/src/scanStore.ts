import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DuplicateGroup, ExecutionScope, PendingScanCandidate, ScanClassification, ScanSnapshot, ResolutionAssessment } from "@immich-dedupe/shared";
import { resolutionAssessmentSchema } from "./reviewedPlan";
import { writeAtomicJson, type JournalFs } from "./atomicJson";

export class ScanStoreError extends Error {
  constructor(message = "Scan progress could not be read or saved. Execution recovery records were not changed.") {
    super(message); this.name = "ScanStoreError";
  }
}

const scopeSchema = z.object({ apiUrl: z.string().url(), accountId: z.string().min(1) }).strict();
const pendingSchema = z.object({
  groupId: z.string().min(1), keepAssetId: z.string().min(1), trashAssetId: z.string().min(1),
  keepFileName: z.string(), trashFileName: z.string(), keepPath: z.string().nullable(), trashPath: z.string().nullable(),
  comparisonClass: z.string().nullable(), reason: z.string(), rulesetRevision: z.string().min(1), observedAt: z.iso.datetime(),
}).strict();
const entrySchema = z.object({
  conflict: z.object({ ruleName: z.string().nullable(), observedAt: z.iso.datetime(), assessment: resolutionAssessmentSchema }).strict().optional(),
  groupId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  assetIds: z.array(z.string().min(1)), status: z.enum(["queued", "eligible", "excluded", "deferred", "error", "blocked"]),
  cacheable: z.boolean(), reason: z.string(), observedAt: z.iso.datetime().nullable(), pending: pendingSchema.nullable(),
}).strict();
const sessionSchema = z.object({
  scope: scopeSchema, rulesetRevision: z.string().min(1), updatedAt: z.iso.datetime(),
  entries: z.array(entrySchema), queue: z.array(z.string().min(1)),
}).strict();
const dataSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) }).strict();
type Entry = z.infer<typeof entrySchema>;
type Session = z.infer<typeof sessionSchema>;
type Data = z.infer<typeof dataSchema>;

function normalizeScope(scope: ExecutionScope): ExecutionScope {
  const parsed = scopeSchema.parse(scope); const url = new URL(parsed.apiUrl);
  if (url.username || url.password || url.search || url.hash) throw new ScanStoreError("Scan scope must use a credential-free Immich API URL.");
  return { apiUrl: url.toString().replace(/\/+$/, ""), accountId: parsed.accountId };
}
function scopeKey(scope: ExecutionScope) { return JSON.stringify([scope.apiUrl, scope.accountId]); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
/** Group/asset ordering is not identity. Every observed field remains a dependency. */
export function scanGroupFingerprint(group: DuplicateGroup): string {
  const assets = group.assets.map((asset) => ({ ...asset,
    albums: [...asset.albums].sort((a, b) => a.albumId.localeCompare(b.albumId) || a.albumName.localeCompare(b.albumName)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(canonical({ groupId: group.groupId, assets })).digest("hex");
}
export type ScanObservation = {
  resolution?: ResolutionAssessment; ruleName?: string | null;
  status: ScanClassification;
  reason: string;
  keepAssetId?: string;
  trashAssetId?: string;
  comparisonClass?: string | null;
  /** Only true if every rule dependency was available in the duplicate-list data.
   * Album-dependent, enriched-only and missing-data outcomes must pass false. */
  cacheable?: boolean;
};
export type ScanStoreOptions = { filePath?: string; now?: () => number; io?: JournalFs; maxGroups?: number; maxScopes?: number };

/** Advisory scheduling, never execution/recovery authority. All IO is lazy.
 * The execution coordinator owns serialization across these operations. */
export function createScanStore(options: ScanStoreOptions = {}) {
  const io = options.io ?? fs; const now = options.now ?? Date.now;
  const maxGroups = options.maxGroups ?? 100_000; const maxScopes = options.maxScopes ?? 20;
  let data: Data | null = null;
  const liveGroups = new Map<string, Map<string, DuplicateGroup>>();
  function load(): Data {
    if (data) return data;
    try {
      const loaded = options.filePath && io.existsSync(options.filePath)
        ? dataSchema.parse(JSON.parse(io.readFileSync(options.filePath, "utf8"))) : { version: 1 as const, sessions: [] };
      if (loaded.sessions.length > maxScopes) throw new Error("Too many scan scopes");
      const scopes = new Set<string>();
      for (const session of loaded.sessions) {
        const normalized = normalizeScope(session.scope); const key = scopeKey(normalized);
        if (key !== scopeKey(session.scope) || scopes.has(key)) throw new Error("Invalid scan scope"); scopes.add(key);
        if (session.entries.length > maxGroups) throw new Error("Too many groups");
        const ids = new Set(session.entries.map((entry) => entry.groupId));
        const queued = new Set(session.entries.filter((entry) => entry.status === "queued").map((entry) => entry.groupId));
        if (ids.size !== session.entries.length || new Set(session.queue).size !== session.queue.length ||
          session.queue.length !== queued.size || session.queue.some((id) => !queued.has(id))) throw new Error("Invalid scan queue");
        for (const entry of session.entries) {
          if (entry.conflict && (!["no-match", "ambiguous"].includes(entry.conflict.assessment.status) || entry.conflict.assessment.assets.some((asset) => !entry.assetIds.includes(asset.id)) || new Set(entry.conflict.assessment.assets.map((asset) => asset.id)).size !== 2 || entry.assetIds.length !== 2)) throw new Error("Invalid resolution conflict membership");
          if (new Set(entry.assetIds).size !== entry.assetIds.length) throw new Error("Invalid membership");
          if ((entry.status === "eligible") !== (entry.pending !== null)) throw new Error("Invalid pending candidate");
          if (entry.pending && (entry.pending.groupId !== entry.groupId || entry.pending.rulesetRevision !== session.rulesetRevision ||
            entry.pending.keepAssetId === entry.pending.trashAssetId || !entry.assetIds.includes(entry.pending.keepAssetId) || !entry.assetIds.includes(entry.pending.trashAssetId))) throw new Error("Invalid candidate selection");
        }
      }
      data = loaded; return loaded;
    } catch { throw new ScanStoreError(); }
  }
  function save(next: Data, deferSave = false) {
    try {
      const validated = dataSchema.parse(next);
      if (options.filePath && !deferSave) writeAtomicJson(options.filePath, validated, io);
      data = validated;
    } catch { throw new ScanStoreError(); }
  }
  function session(scope: ExecutionScope) {
    const normalized = normalizeScope(scope); const key = scopeKey(normalized);
    return { key, scope: normalized, current: load().sessions.find((s) => scopeKey(s.scope) === key) };
  }
  function replace(current: Session, deferSave = false) {
    const next = structuredClone(load()); const key = scopeKey(current.scope);
    const index = next.sessions.findIndex((s) => scopeKey(s.scope) === key);
    if (index < 0) {
      if (next.sessions.length >= maxScopes) throw new ScanStoreError("The scan scope capacity was reached. Reset unused scan progress before starting another scope.");
      next.sessions.push(current);
    } else next.sessions[index] = current;
    save(next, deferSave);
  }
  function snapshot(scope: ExecutionScope): ScanSnapshot {
    const { scope: normalized, current } = session(scope); const entries = current?.entries ?? [];
    const pending = entries.flatMap((entry) => entry.pending ? [entry.pending] : []);
    return structuredClone({ scope: normalized, summary: {
      rulesetRevision: current?.rulesetRevision ?? "unprepared", totalGroups: entries.length,
      visitedGroups: entries.filter((entry) => entry.status !== "queued" && entry.status !== "blocked").length,
      remainingGroups: current?.queue.length ?? 0,
      excludedGroups: entries.filter((entry) => entry.status === "excluded").length,
      deferredGroups: entries.filter((entry) => entry.status === "deferred" || entry.status === "error").length,
      blockedGroups: entries.filter((entry) => entry.status === "blocked").length,
      pendingCandidates: pending.length, updatedAt: current?.updatedAt ?? new Date(now()).toISOString(),
    }, pending, conflicts: entries.flatMap((entry) => entry.conflict ? [{ groupId: entry.groupId, rulesetRevision: current!.rulesetRevision, ...entry.conflict }] : []) });
  }
  return {
    begin(scope: ExecutionScope, rulesetRevision: string, groups: DuplicateGroup[], blocked: {
      blockedGroupIds?: Iterable<string>; blockedAssetIds?: Iterable<string>;
    } = {}): ScanSnapshot {
      const found = session(scope);
      if (!rulesetRevision || groups.length > maxGroups) throw new ScanStoreError("The scan snapshot exceeds the configured capacity or has no rules revision.");
      const byId = new Map<string, DuplicateGroup>();
      for (const group of groups) {
        if (!group.groupId || byId.has(group.groupId)) throw new ScanStoreError("The duplicate list contains repeated or missing group IDs.");
        byId.set(group.groupId, structuredClone(group));
      }
      const blockedGroups = new Set(blocked.blockedGroupIds); const blockedAssets = new Set(blocked.blockedAssetIds);
      const previous = found.current; const sameRevision = previous?.rulesetRevision === rulesetRevision;
      const previousEntries = new Map(previous?.entries.map((entry) => [entry.groupId, entry]));
      const entries: Entry[] = [];
      for (const group of groups) {
        const fingerprint = scanGroupFingerprint(group); const old = previousEntries.get(group.groupId);
        const blockedGroup = blockedGroups.has(group.groupId) || group.assets.some((asset) => blockedAssets.has(asset.id));
        const reusable = sameRevision && old?.fingerprint === fingerprint &&
          (old.status === "queued" || old.status === "eligible" || (old.status === "excluded" && old.cacheable));
        if (!blockedGroup && reusable) entries.push(structuredClone(old));
        else entries.push({ groupId: group.groupId, fingerprint, assetIds: [...new Set(group.assets.map((asset) => asset.id))],
          ...(!blockedGroup && sameRevision && old?.fingerprint === fingerprint && old.conflict ? { conflict: structuredClone(old.conflict) } : {}),
          status: blockedGroup ? "blocked" : "queued", cacheable: false, reason: blockedGroup ? "Blocked by execution history or recovery quarantine" : "",
          observedAt: null, pending: null });
      }
      const queued = new Set(entries.filter((entry) => entry.status === "queued").map((entry) => entry.groupId));
      // Existing unseen work wins over newly observed/changed/deferred work.
      const queue = (previous?.queue ?? []).filter((id) => queued.has(id));
      const alreadyQueued = new Set(queue);
      const additions = entries.filter((entry) => queued.has(entry.groupId) && !alreadyQueued.has(entry.groupId));
      const freshWork = (entry: Entry) => {
        const old = previousEntries.get(entry.groupId);
        return !sameRevision || !old || old.fingerprint !== entry.fingerprint;
      };
      // Fresh arrivals/changed evidence must not sit behind an exhausted library's
      // deferred or enriched-only exclusions simply because Immich lists them first.
      queue.push(...additions.filter(freshWork).map((entry) => entry.groupId),
        ...additions.filter((entry) => !freshWork(entry)).map((entry) => entry.groupId));
      const next: Session = { scope: found.scope, rulesetRevision, updatedAt: new Date(now()).toISOString(), entries, queue };
      replace(next); liveGroups.set(found.key, byId); return snapshot(scope);
    },
    next(scope: ExecutionScope): DuplicateGroup | null {
      const found = session(scope); const nextId = found.current?.queue[0];
      if (!nextId) return null;
      const group = liveGroups.get(found.key)?.get(nextId);
      if (!group) throw new ScanStoreError("Refresh the duplicate list before continuing persisted scan progress.");
      return structuredClone(group);
    },
    record(scope: ExecutionScope, groupId: string, observation: ScanObservation, writeOptions: { deferSave?: boolean } = {}): ScanSnapshot {
      const found = session(scope); if (!found.current) throw new ScanStoreError("Prepare a scan before recording a result.");
      const next = structuredClone(found.current); const entry = next.entries.find((item) => item.groupId === groupId);
      const group = liveGroups.get(found.key)?.get(groupId);
      if (!entry || entry.status !== "queued" || !group) throw new ScanStoreError("Only an unfinished group in the current snapshot can be recorded.");
      let pending: PendingScanCandidate | null = null;
      const timestamp = new Date(now()).toISOString();
      if (observation.status === "eligible") {
        const keep = group.assets.find((asset) => asset.id === observation.keepAssetId);
        const trash = group.assets.find((asset) => asset.id === observation.trashAssetId);
        if (!keep || !trash || keep.id === trash.id) throw new ScanStoreError("A pending proposal requires two distinct assets in the group.");
        pending = { groupId, keepAssetId: keep.id, trashAssetId: trash.id, keepFileName: keep.fileName, trashFileName: trash.fileName,
          keepPath: keep.originalPath, trashPath: trash.originalPath, comparisonClass: observation.comparisonClass ?? null,
          reason: observation.reason, rulesetRevision: next.rulesetRevision, observedAt: timestamp };
      }
      entry.status = observation.status; entry.reason = observation.reason; entry.observedAt = timestamp;
      entry.cacheable = observation.status === "excluded" && observation.cacheable === true; entry.pending = pending;
      entry.conflict = observation.resolution && ["no-match", "ambiguous"].includes(observation.resolution.status) && observation.status === "excluded"
        ? { ruleName: observation.ruleName ?? null, observedAt: timestamp, assessment: observation.resolution } : undefined;
      next.queue = next.queue.filter((id) => id !== groupId); next.updatedAt = timestamp;
      replace(next, writeOptions.deferSave === true); return snapshot(scope);
    },
    /** Commit buffered advisory observations, normally every 25 completed groups and
     * before returning a terminal/cancelled response. A crash can lose read-only
     * progress since the last flush; it can never authorize execution. */
    flush() { save(load()); },
    get: snapshot,
    getPending(scope: ExecutionScope): PendingScanCandidate[] { return snapshot(scope).pending; },
    recheckExcluded(scope: ExecutionScope): ScanSnapshot {
      const found = session(scope); if (!found.current) return snapshot(scope);
      const next = structuredClone(found.current);
      for (const entry of next.entries) if (["excluded", "deferred", "error"].includes(entry.status)) {
        entry.status = "queued"; entry.cacheable = false; entry.reason = ""; entry.observedAt = null;
        entry.conflict = undefined;
        if (!next.queue.includes(entry.groupId)) next.queue.push(entry.groupId);
      }
      next.updatedAt = new Date(now()).toISOString(); replace(next); return snapshot(scope);
    },
    removePending(scope: ExecutionScope, groupIds: Iterable<string>): ScanSnapshot {
      const found = session(scope); if (!found.current) return snapshot(scope);
      const ids = new Set(groupIds); const next = structuredClone(found.current);
      next.entries = next.entries.filter((entry) => !ids.has(entry.groupId)); next.queue = next.queue.filter((id) => !ids.has(id));
      next.updatedAt = new Date(now()).toISOString(); replace(next); return snapshot(scope);
    },
    reset(scope: ExecutionScope): ScanSnapshot {
      const found = session(scope); const next = structuredClone(load());
      next.sessions = next.sessions.filter((s) => scopeKey(s.scope) !== found.key); save(next); liveGroups.delete(found.key);
      return snapshot(scope);
    },
    /** Explicit administrative reset only; permits recovery from corrupt advisory storage.
     * Never invoked on read failure and never touches journal files. */
    resetAll() { save({ version: 1, sessions: [] }); liveGroups.clear(); },
  };
}
export type ScanStore = ReturnType<typeof createScanStore>;
