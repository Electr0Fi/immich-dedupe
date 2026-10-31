import fs from "node:fs";
import { reviewedCandidateSchema, configurableCandidateSchema, resolutionCandidateSchema, candidateFromGroup, changedCandidate } from "./reviewedPlan";
import type { AssetRecord, ReviewedCandidate, ReviewedRunEvidence } from "@immich-dedupe/shared";
import path from "node:path";
import { z } from "zod";
import type { ExecutionCheckpoint, ExecutionScope, RecoveryAttempt, ExecutionResult, RecoveryAssessment } from "@immich-dedupe/shared";
import type { ExecutionLogEntry } from "./executionLog";
import { writeAtomicJson, type JournalFs } from "./atomicJson";

const id = z.string().min(1);
const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const ids = z.array(id).refine((items) => new Set(items).size === items.length, "Duplicate IDs");
export const resultSchema = z.object({
  runId: uuid.optional(), attemptId: uuid.optional(), groupId: id, mode: z.enum(["dry-run", "execute"]),
  outcome: z.enum(["dry-run", "succeeded", "failed", "needs-verification"]),
  failureStage: z.enum(["preflight", "album-transfer", "album-verification", "resolution", "verification"]).nullable(),
  proposedAlbumIds: ids, transferredAlbumIds: ids, skippedAlbumIds: ids,
  executed: z.boolean(), resolvedDuplicate: z.boolean(), trashedAsset: z.boolean(),
  keepAssetId: id.nullable(), trashAssetId: id.nullable(), message: z.string(),
});
const snapshotAsset = z.object({
  id, duplicateId: id, fileName: id, originalPath: id, assetType: z.literal("IMAGE"),
  width: z.number().positive(), height: z.number().positive(), fileSize: z.number().positive(),
  isEdited: z.literal(false), isTrashed: z.literal(false), isFavorite: z.literal(false),
  isArchived: z.literal(false), isOffline: z.literal(false), livePhotoVideoId: z.null(),
  isExternal: z.boolean(), isInternal: z.boolean(),
}).passthrough();
const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preflight"), snapshot: z.array(snapshotAsset).length(2), requiredAlbumIds: ids, proposedAlbumIds: ids, skippedAlbumIds: ids }),
  z.object({ kind: z.literal("album-intent"), albumIds: ids.nonempty() }),
  z.object({ kind: z.literal("album-response"), accepted: z.boolean(), error: z.string().nullable() }),
  z.object({ kind: z.literal("album-observed"), confirmedAlbumIds: ids }),
  z.object({ kind: z.literal("resolution-intent") }),
  z.object({ kind: z.literal("resolution-response"), accepted: z.boolean(), items: z.array(z.object({ id, success: z.boolean() })), error: z.string().nullable() }),
  z.object({ kind: z.literal("verification"), loserTrashed: z.boolean(), loserUnlinked: z.boolean(), keeperUntrashed: z.boolean() }),
]);
const assessmentSchema = z.object({
  checkedAt: timestamp, classification: z.enum(["verified-resolved", "pair-intact", "inconclusive"]), message: z.string(), evidence: z.array(z.string()),
});
const attemptSchema = z.object({
  attemptId: uuid, runId: uuid, groupId: id, mode: z.enum(["dry-run", "execute"]),
  keepAssetId: id.nullable(), trashAssetId: id.nullable(), startedAt: timestamp,
  checkpoints: z.array(z.object({ timestamp, event: checkpointSchema })), result: resultSchema.nullable(),
  assessments: z.array(assessmentSchema), releasedAt: timestamp.nullable(),
});
const scopeSchema = z.object({ apiUrl: z.string().url(), accountId: id }).refine((scope) => {
  const url = new URL(scope.apiUrl);
  return scope.apiUrl === `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}, "Scope URL must be normalized and contain no credentials, query or fragment");
const contextSchema = z.object({ dryRun: z.boolean(), scanLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), executeLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), source: z.enum(["batch", "single"]), groupId: id.nullable() });
const reportSchema = z.object({
  fetchedGroups: z.number().int().nonnegative(), eligibleCount: z.number().int().nonnegative(),
  excludedGroups: z.array(z.object({ groupId: id, reason: z.enum(["processed", "legacy", "quarantined"]), attemptIds: z.array(uuid) })),
  stoppedEarly: z.boolean(), stopReason: z.string().nullable(),
  requestError: z.object({ status: z.number().int().min(400).max(599), code: id, message: z.string() }).nullable(),
});
const reviewSchema = z.object({
  planId: uuid, createdAt: timestamp, expiresAt: timestamp, selectedGroupIds: ids.nonempty(),
  candidates: z.array(reviewedCandidateSchema).nonempty(), authorizingDryRunId: uuid.nullable(),
}).strict();
const configuredReviewSchema = reviewSchema.extend({ candidates: z.array(configurableCandidateSchema).nonempty() });
const resolutionReviewSchema = reviewSchema.extend({ candidates: z.array(resolutionCandidateSchema).nonempty() });
const runFields = { runId: uuid, scope: scopeSchema, startedAt: timestamp, finishedAt: timestamp.nullable(), attempts: z.array(attemptSchema) };
const runSchema = z.discriminatedUnion("version", [
  z.object({ ...runFields, version: z.literal(1) }),
  z.object({ ...runFields, version: z.literal(2), context: contextSchema, report: reportSchema.nullable() }),
  z.object({ ...runFields, version: z.literal(3), context: contextSchema, report: reportSchema.nullable(), review: reviewSchema }),
  z.object({ ...runFields, version: z.literal(4), context: contextSchema, report: reportSchema.nullable(), review: configuredReviewSchema }),
  z.object({ ...runFields, version: z.literal(5), context: contextSchema, report: reportSchema.nullable(), review: resolutionReviewSchema }),
]);
const legacySchema = z.object({ version: z.literal(1), scope: scopeSchema, importedAt: timestamp, groupIds: ids });
type WithAttempts<T> = T extends { review: unknown } ? Omit<T, "attempts" | "review"> & { attempts: RecoveryAttempt[]; review: ReviewedRunEvidence } : T extends unknown ? Omit<T, "attempts"> & { attempts: RecoveryAttempt[] } : never;
export type JournalRun = WithAttempts<z.infer<typeof runSchema>>;
export class JournalError extends Error {}
export function sameScope(a: ExecutionScope, b: ExecutionScope) { return a.apiUrl === b.apiUrl && a.accountId === b.accountId; }
export function isUnresolved(attempt: RecoveryAttempt) {
  if (attempt.releasedAt || attempt.assessments.at(-1)?.classification === "verified-resolved") return false;
  return attempt.result === null || attempt.result.outcome === "needs-verification";
}

function sameIds(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function validateRun(value: unknown): JournalRun {
  const run = runSchema.parse(value);
  if (run.version !== 1) {
    if ((run.context.source === "single") !== (run.context.groupId !== null)) throw new Error("Inconsistent run source");
    if (run.finishedAt !== null && run.report === null) throw new Error("Missing terminal report");
    if (run.report !== null && run.finishedAt === null) throw new Error("Unfinished terminal report");
    if (run.attempts.length > run.context.executeLimit || run.attempts.some((a) => a.mode !== (run.context.dryRun ? "dry-run" : "execute") || (run.context.source === "single" && a.groupId !== run.context.groupId))) throw new Error("Inconsistent request context");
    if (run.report && (run.report.eligibleCount > run.report.fetchedGroups ||
        (run.context.source === "batch" && run.attempts.length > run.report.eligibleCount) ||
        run.report.stoppedEarly !== (run.report.stopReason !== null) ||
        (run.attempts.some((a) => a.result?.outcome === "failed" || a.result?.outcome === "needs-verification") && !run.report.stoppedEarly) ||
        (run.report.requestError && !run.report.stoppedEarly))) throw new Error("Inconsistent terminal report");
  }
  if (run.version === 3 || run.version === 4 || run.version === 5) {
    const review = run.review;
    if (run.version === 4 || run.version === 5) {
      const configured = run.review;
      if (configured.candidates.some((candidate) => candidate.ruleset.revision !== configured.candidates[0].ruleset.revision)) throw new Error("Mixed ruleset revisions");
    }
    if (Date.parse(review.expiresAt) - Date.parse(review.createdAt) !== 15 * 60 * 1000 ||
        JSON.stringify(review.selectedGroupIds) !== JSON.stringify(review.candidates.map((c) => c.groupId)) ||
        review.selectedGroupIds.length > run.context.executeLimit || run.context.source !== "batch" ||
        (run.context.dryRun ? review.authorizingDryRunId !== null : !review.authorizingDryRunId || review.authorizingDryRunId === run.runId) ||
        run.attempts.some((a, i) => a.groupId !== review.selectedGroupIds[i] || a.keepAssetId !== review.candidates[i].keepAsset.id || a.trashAssetId !== review.candidates[i].trashAsset.id)) throw new Error("Inconsistent reviewed run");
    for (const attempt of run.attempts) for (const { event } of attempt.checkpoints) if (event.kind === "preflight") {
      const candidate: ReviewedCandidate = review.candidates.find((c) => c.groupId === attempt.groupId)!;
      const actual = candidateFromGroup({ groupId: attempt.groupId, assets: event.snapshot as unknown as AssetRecord[] }, candidate.decision, candidate.ruleset);
      if (changedCandidate(candidate, actual).length) throw new Error("Reviewed preflight differs from authorized evidence");
    }
  }
  const seen = new Set<string>();
  for (const attempt of run.attempts) {
    if (attempt.runId !== run.runId || seen.has(attempt.attemptId)) throw new Error("Inconsistent attempt identity");
    seen.add(attempt.attemptId);
    let preflight: { requiredAlbumIds: string[]; proposedAlbumIds: string[]; skippedAlbumIds: string[] } | undefined;
    let albumIntent = false, albumResponse = false, observed = false, resolutionIntent = false, resolutionResponse = false;
    let albumAccepted = false, allAlbumsConfirmed = false, resolutionAccepted = false;
    for (const { event } of attempt.checkpoints) {
      if (event.kind === "preflight") {
        if (preflight || resolutionIntent || albumIntent) throw new Error("Duplicate/out-of-order preflight");
        if (!event.snapshot.some((a) => a.id === attempt.keepAssetId) || !event.snapshot.some((a) => a.id === attempt.trashAssetId) ||
            event.snapshot.some((a) => a.duplicateId !== attempt.groupId) || attempt.keepAssetId === attempt.trashAssetId) throw new Error("Inconsistent selection");
        if (event.requiredAlbumIds.length !== event.proposedAlbumIds.length + event.skippedAlbumIds.length ||
            !event.requiredAlbumIds.every((album) => [...event.proposedAlbumIds, ...event.skippedAlbumIds].includes(album))) throw new Error("Inconsistent albums");
        preflight = event;
      } else {
        if (!preflight || attempt.mode !== "execute") throw new Error("Missing preflight or dry-run mutation");
        if (event.kind === "album-intent") {
          if (albumIntent || resolutionIntent || !sameIds(event.albumIds, preflight.proposedAlbumIds)) throw new Error("Invalid album intent");
          albumIntent = true;
        }
        if (event.kind === "album-response") { if (event.accepted && event.error !== null) throw new Error("Contradictory album response"); if (!albumIntent || albumResponse || resolutionIntent) throw new Error("Missing album intent"); albumResponse = true; albumAccepted = event.accepted; }
        if (event.kind === "album-observed") {
          if (!albumResponse || observed || event.confirmedAlbumIds.some((album) => !preflight!.proposedAlbumIds.includes(album))) throw new Error("Invalid album observation"); observed = true; allAlbumsConfirmed = event.confirmedAlbumIds.length === preflight.proposedAlbumIds.length;
        }
        if (event.kind === "resolution-intent") {
          if (resolutionIntent || (preflight.proposedAlbumIds.length && (!observed || !albumAccepted || !allAlbumsConfirmed))) throw new Error("Invalid resolution intent"); resolutionIntent = true;
        }
        if (event.kind === "resolution-response") { if (event.accepted && (!event.items.length || event.items.some((item) => !item.success) || event.error !== null)) throw new Error("Contradictory resolution response"); if (!resolutionIntent || resolutionResponse) throw new Error("Missing resolution intent"); resolutionResponse = true; resolutionAccepted = event.accepted; }
        if (event.kind === "verification" && event.loserUnlinked && !event.loserTrashed) throw new Error("Contradictory verification");
        if (event.kind === "verification" && (!resolutionResponse || !resolutionAccepted)) throw new Error("Missing resolution response");
      }
    }
    const result = attempt.result;
    if (result && (result.runId !== run.runId || result.attemptId !== attempt.attemptId || result.groupId !== attempt.groupId || result.mode !== attempt.mode ||
        result.keepAssetId !== attempt.keepAssetId || result.trashAssetId !== attempt.trashAssetId)) throw new Error("Inconsistent result identity");
    if (result?.outcome === "succeeded" && (!resolutionResponse || !resolutionAccepted || !result.executed || !result.trashedAsset || !result.resolvedDuplicate || attempt.mode !== "execute" ||
        !attempt.checkpoints.some((c) => c.event.kind === "verification" && c.event.loserTrashed && c.event.loserUnlinked && c.event.keeperUntrashed))) throw new Error("Unverified success");
    if (result && ((result.outcome === "succeeded" || result.outcome === "dry-run") ? result.failureStage !== null : result.failureStage === null)) throw new Error("Inconsistent failure stage");
    if (result && preflight && (!sameIds(result.proposedAlbumIds, preflight.proposedAlbumIds) || !sameIds(result.skippedAlbumIds, preflight.skippedAlbumIds))) throw new Error("Inconsistent result albums");
    if (result && result.transferredAlbumIds.some((album) => !attempt.checkpoints.some((checkpoint) => checkpoint.event.kind === "album-observed" && checkpoint.event.confirmedAlbumIds.includes(album)))) throw new Error("Unconfirmed album transfer in result");
    if (result?.trashedAsset && !attempt.checkpoints.some((checkpoint) => checkpoint.event.kind === "verification" && checkpoint.event.loserTrashed)) throw new Error("Unconfirmed trash state in result");
    if (result?.resolvedDuplicate && !attempt.checkpoints.some((checkpoint) => checkpoint.event.kind === "verification" && checkpoint.event.loserUnlinked)) throw new Error("Unconfirmed resolution in result");
    if (result?.executed && result.outcome !== "succeeded") throw new Error("Invalid execution flag");
    if (result?.outcome === "dry-run" && (attempt.mode !== "dry-run" || !preflight)) throw new Error("Invalid dry-run result");
    if (result?.outcome === "failed" && (albumIntent || resolutionIntent)) throw new Error("Mutation cannot be known untouched");
    if (result?.outcome === "needs-verification" && (attempt.mode !== "execute" || (!albumIntent && !resolutionIntent))) throw new Error("Invalid uncertain result");
    if (attempt.assessments.length && result && result.outcome !== "needs-verification") throw new Error("Assessment of closed attempt");
    if (attempt.assessments.some((assessment) => assessment.classification !== "inconclusive" && assessment.evidence.length < 3)) throw new Error("Missing assessment evidence");
    if (attempt.assessments.slice(0, -1).some((assessment) => assessment.classification === "verified-resolved")) throw new Error("Assessment after resolution");
    if (attempt.releasedAt && (attempt.assessments.at(-1)?.classification !== "pair-intact" || attempt.assessments.at(-1)?.checkedAt !== attempt.releasedAt)) throw new Error("Unverified release");
  }
  if (run.finishedAt && run.attempts.some((a) => a.result === null)) throw new Error("Unfinished attempt in finished run");
  return run as unknown as JournalRun;
}

function validateAuthorization(run: JournalRun, records: Map<string, JournalRun>) {
  if ((run.version !== 3 && run.version !== 4 && run.version !== 5) || run.context.dryRun) return;
  const authorization = records.get(run.review.authorizingDryRunId!);
  if (!authorization || (authorization.version !== 3 && authorization.version !== 4 && authorization.version !== 5) || authorization.version !== run.version || !sameScope(run.scope, authorization.scope) || !authorization.context.dryRun ||
      !authorization.finishedAt || authorization.context.scanLimit !== run.context.scanLimit || authorization.context.executeLimit !== run.context.executeLimit || !authorization.report || authorization.report.stoppedEarly || authorization.report.requestError ||
      JSON.stringify(authorization.review) !== JSON.stringify({ ...run.review, authorizingDryRunId: null }) ||
      authorization.attempts.length !== run.review.selectedGroupIds.length || authorization.attempts.some((a) => a.result?.outcome !== "dry-run")) throw new Error("Missing successful reviewed dry-run evidence");
}

/** Lazy loading keeps createApp side-effect free. Any integrity/write failure poisons this instance. */
export function createExecutionJournal(directory: string, io: JournalFs = fs) {
  let loaded = false;
  let error: string | null = null;
  let runs = new Map<string, JournalRun>();
  let attemptIndex = new Map<string, string>();
  let legacy: z.infer<typeof legacySchema> | null = null;
  function fail() { error = "Recovery storage is unavailable or inconsistent; preserve the journal files and repair storage before execution."; throw new JournalError(error); }
  function load() {
    if (error) throw new JournalError(error);
    if (loaded) return;
    try {
      const next = new Map<string, JournalRun>();
      const attemptIds = new Set<string>();
      if (io.existsSync(directory)) for (const filename of io.readdirSync(directory) as string[]) {
        if (filename === "legacy-exclusions.json") { legacy = legacySchema.parse(JSON.parse(io.readFileSync(path.join(directory, filename), "utf8") as string)); continue; }
        if (!filename.endsWith(".json")) continue; // Interrupted temporary files are never promoted.
        const run = validateRun(JSON.parse(io.readFileSync(path.join(directory, filename), "utf8") as string));
        if (filename !== `${run.runId}.json` || next.has(run.runId)) throw new Error("Invalid run filename");
        for (const attempt of run.attempts) { if (attemptIds.has(attempt.attemptId)) throw new Error("Duplicate attempt"); attemptIds.add(attempt.attemptId); }
        next.set(run.runId, run);
      }
      for (const run of next.values()) validateAuthorization(run, next);
      if (next.size && !legacy) throw new Error("Legacy migration marker is missing");
      runs = next;
      attemptIndex = new Map([...runs.values()].flatMap((run) => run.attempts.map((attempt) => [attempt.attemptId, run.runId] as const)));
      loaded = true;
    } catch { fail(); }
  }
  function save(run: JournalRun) {
    load();
    try {
      validateRun(run);
      validateAuthorization(run, runs);
      const previous = runs.get(run.runId);
      if (previous) {
        if (((previous.version === 3 || previous.version === 4 || previous.version === 5) && (run.version === 3 || run.version === 4 || run.version === 5) && JSON.stringify(previous.review) !== JSON.stringify(run.review)) || previous.version !== run.version || (previous.version !== 1 && run.version !== 1 && (JSON.stringify(previous.context) !== JSON.stringify(run.context) || (previous.report !== null && JSON.stringify(previous.report) !== JSON.stringify(run.report)))) || !sameScope(previous.scope, run.scope) || previous.startedAt !== run.startedAt ||
            (previous.finishedAt !== null && (previous.finishedAt !== run.finishedAt || previous.attempts.length !== run.attempts.length)) || previous.attempts.length > run.attempts.length) throw new Error("Existing run evidence cannot be replaced");
        for (const [index, before] of previous.attempts.entries()) {
          const after = run.attempts[index];
          if (before.attemptId !== after.attemptId || before.groupId !== after.groupId || before.mode !== after.mode || before.startedAt !== after.startedAt ||
              before.keepAssetId !== after.keepAssetId || before.trashAssetId !== after.trashAssetId ||
              JSON.stringify(before.checkpoints) !== JSON.stringify(after.checkpoints.slice(0, before.checkpoints.length)) ||
              JSON.stringify(before.assessments) !== JSON.stringify(after.assessments.slice(0, before.assessments.length)) ||
              (before.result !== null && (JSON.stringify(before.result) !== JSON.stringify(after.result) || before.checkpoints.length !== after.checkpoints.length)) ||
              (before.releasedAt !== null && before.releasedAt !== after.releasedAt)) throw new Error("Existing attempt evidence cannot be replaced");
        }
      }
      for (const attempt of run.attempts) {
        const owner = attemptIndex.get(attempt.attemptId);
        if (owner && owner !== run.runId) throw new Error("Duplicate attempt identity across runs");
      }
      writeAtomicJson(path.join(directory, `${run.runId}.json`), run, io);
      runs.set(run.runId, structuredClone(run));
      for (const attempt of run.attempts) attemptIndex.set(attempt.attemptId, run.runId);
    } catch { fail(); }
  }
  function all(scope: ExecutionScope) { load(); return structuredClone([...runs.values()].filter((r) => sameScope(r.scope, scope))); }
  return {
    initialize: load,
    health() { try { load(); } catch { /* diagnostic read remains usable */ } return { health: error ? "unavailable" as const : "ready" as const, error }; },
    migrate(scope: ExecutionScope, readLog: () => ExecutionLogEntry[]) {
      load(); if (legacy) return;
      try {
        const groupIds = [...new Set(readLog().filter((e) => e.mode === "execute" && e.executed && e.resolvedDuplicate && e.trashedAsset).map((e) => e.groupId))];
        const record = legacySchema.parse({ version: 1, scope, importedAt: new Date().toISOString(), groupIds });
        writeAtomicJson(path.join(directory, "legacy-exclusions.json"), record, io);
        legacy = record;
      } catch { fail(); }
    },
    legacyIds(scope: ExecutionScope) { load(); return new Set(legacy && sameScope(legacy.scope, scope) ? legacy.groupIds : []); },
    runs: all,
    run(scope: ExecutionScope, runId: string) {
      load(); const run = runs.get(runId);
      return run && sameScope(run.scope, scope) ? structuredClone(run) : null;
    },
    unresolved(scope: ExecutionScope) {
      load();
      return structuredClone([...runs.values()].filter((run) => sameScope(run.scope, scope)).flatMap((run) => run.attempts).filter(isUnresolved));
    },
    exclusionIndex(scope: ExecutionScope) {
      load();
      const attempts = [...runs.values()].filter((run) => sameScope(run.scope, scope)).flatMap((run) => run.attempts);
      return {
        processed: new Set(attempts.filter((a) => a.result?.outcome === "succeeded" || a.assessments.at(-1)?.classification === "verified-resolved").map((a) => a.groupId)),
        legacy: new Set(legacy && sameScope(legacy.scope, scope) ? legacy.groupIds : []),
        blocked: attempts.filter(isUnresolved).map(({ attemptId, groupId, keepAssetId, trashAssetId }) => ({ attemptId, groupId, keepAssetId, trashAssetId })),
      };
    },
    save,
    attempt(scope: ExecutionScope, attemptId: string) {
      load(); const runId = attemptIndex.get(attemptId);
      const cached = runId ? runs.get(runId) : undefined;
      if (!cached || !sameScope(cached.scope, scope)) return null;
      const run = structuredClone(cached);
      const attempt = run.attempts.find((item) => item.attemptId === attemptId);
      return attempt ? { run, attempt } : null;
    },
    updateAttempt(scope: ExecutionScope, attemptId: string, update: (attempt: RecoveryAttempt) => void) {
      const found = this.attempt(scope, attemptId);
      if (!found) throw new Error("Attempt not found");
      update(found.attempt); save(found.run); return found.attempt;
    },
    checkpoint(scope: ExecutionScope, attemptId: string, event: ExecutionCheckpoint) {
      this.updateAttempt(scope, attemptId, (attempt) => { attempt.checkpoints.push({ timestamp: new Date().toISOString(), event }); });
    },
    finish(scope: ExecutionScope, attemptId: string, result: ExecutionResult) {
      this.updateAttempt(scope, attemptId, (attempt) => { attempt.result = result; });
    },
    assess(scope: ExecutionScope, attemptId: string, assessment: RecoveryAssessment, release = false) {
      return this.updateAttempt(scope, attemptId, (attempt) => {
        attempt.assessments.push(assessment);
        if (release) attempt.releasedAt = assessment.checkedAt;
      });
    },
  };
}
export type ExecutionJournal = ReturnType<typeof createExecutionJournal>;
