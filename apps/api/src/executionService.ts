import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DuplicateGroup, DuplicateDecision, ExecutionResult, ExecutionScope, ExecutionExclusion, RecoveryAttempt, RunView, RunViewResponse, RunReport } from "@immich-dedupe/shared";
import { createDecisionExecutor, CheckpointFailure } from "./executeDecision";
import { isExecutableDecision } from "./executePlan";
import { JournalError, isUnresolved, type ExecutionJournal } from "./executionJournal";
import { reconcileAttempt } from "./reconcileAttempt";
import type { ImmichClient } from "./immichClient";
import type { ExecutionLog } from "./executionLog";

export class ExecutionServiceError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export type ExecutionOptions = { dryRun: boolean; scanLimit: number; executeLimit: number; singleGroupId?: string };
type LoadedGroups = { groups: DuplicateGroup[]; decisions: DuplicateDecision[] };

export function normalizeApiUrl(value: string) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
export function createExecutionService(deps: {
  client: ImmichClient; apiUrl: string; journal: ExecutionJournal; log: ExecutionLog;
  delay?: (ms: number) => Promise<void>;
}) {
  const { client, journal, log } = deps;
  let activeRunId: string | null = null;
  let lastScope: ExecutionScope | null = null;
  async function identity(): Promise<ExecutionScope> {
    try {
      const user = z.object({ id: z.string().min(1) }).parse(await client.getMyUser());
      lastScope = { apiUrl: normalizeApiUrl(deps.apiUrl), accountId: user.id };
      return lastScope;
    } catch (error) {
      // Only expose known diagnostics, never raw SDK errors containing connection details.
      const response = z.object({ status: z.number(), data: z.object({ message: z.string() }).optional() }).safeParse(error);
      let reason = "Check that Immich is reachable and the configured API key permits the current-user lookup (user.read).";
      if (response.success && response.data.status === 403) {
        reason = response.data.data?.message === "Missing required permission: user.read"
          ? "Immich denied the current-user lookup: the API key is missing user.read. Enable user.read for the configured key in Immich."
          : "Immich denied the current-user lookup (HTTP 403). Check the configured API key's user.read permission and server access rules.";
      } else if (response.success && response.data.status === 401) {
        reason = "Immich rejected the configured credentials (HTTP 401). Check the API key and restart the API after changing it.";
      }
      throw new ExecutionServiceError(503, "identity_unavailable", `Cannot verify the Immich connection identity. ${reason} No execution or recovery changes were performed.`);
    }
  }
  async function exclusive<T>(action: (runId: string, scope: ExecutionScope) => Promise<T>): Promise<T> {
    if (activeRunId) throw new ExecutionServiceError(409, "execution_busy", "Another execution or recovery action is running", { activeRunId });
    const runId = randomUUID(); activeRunId = runId;
    try {
      journal.initialize();
      const scope = await identity();
      journal.migrate(scope, log.loadExecutionLog);
      return await action(runId, scope);
    } catch (error) {
      if (error instanceof ExecutionServiceError) throw error;
      if (error instanceof JournalError) throw new ExecutionServiceError(503, "journal_unavailable", error.message, { runId });
      throw new ExecutionServiceError(500, "execution_error", error instanceof Error ? error.message : "Execution failed", { runId });
    } finally { activeRunId = null; }
  }
  function exclusions(index: ReturnType<ExecutionJournal["exclusionIndex"]>, group: DuplicateGroup): ExecutionExclusion | null {
    const blocked = index.blocked.filter((a) => a.groupId === group.groupId || group.assets.some((asset) => asset.id === a.keepAssetId || asset.id === a.trashAssetId));
    if (blocked.length) return { groupId: group.groupId, reason: "quarantined", attemptIds: blocked.map((a) => a.attemptId) };
    if (index.processed.has(group.groupId)) return { groupId: group.groupId, reason: "processed", attemptIds: [] };
    if (index.legacy.has(group.groupId)) return { groupId: group.groupId, reason: "legacy", attemptIds: [] };
    return null;
  }
  function unresolved(scope: ExecutionScope) {
    return journal.unresolved(scope).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  function findAttempt(scope: ExecutionScope, attemptId: string) {
    const found = journal.attempt(scope, attemptId);
    if (!found) throw new ExecutionServiceError(404, "attempt_not_found", "Attempt not found for the current connection");
    return found.attempt;
  }
  async function readRun(runId?: string): Promise<RunViewResponse> {
    journal.initialize();
    const scope = await identity();
    const record = runId ? journal.run(scope, runId) : journal.runs(scope).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))[0];
    if (!record && runId) throw new ExecutionServiceError(404, "run_not_found", "Run not found for the current connection");
    const run: RunView | null = record ? {
      runId: record.runId, startedAt: record.startedAt, finishedAt: record.finishedAt,
      phase: activeRunId === record.runId ? "running" : record.finishedAt ? "finished" : "interrupted",
      context: record.version === 2 ? record.context : null, report: record.version === 2 ? record.report : null,
      attempts: record.attempts.map((attempt) => ({
        attemptId: attempt.attemptId, groupId: attempt.groupId, mode: attempt.mode,
        keepAssetId: attempt.keepAssetId, trashAssetId: attempt.trashAssetId, result: attempt.result,
        lastStage: attempt.checkpoints.at(-1)?.event.kind ?? "prepared",
        confirmedAlbumIds: attempt.result?.transferredAlbumIds ?? attempt.checkpoints.flatMap(({ event }) => event.kind === "album-observed" ? event.confirmedAlbumIds : []),
        confirmedEffects: {
          loserTrashed: attempt.checkpoints.some(({ event }) => event.kind === "verification" && event.loserTrashed),
          loserUnlinked: attempt.checkpoints.some(({ event }) => event.kind === "verification" && event.loserUnlinked),
          keeperUntrashed: attempt.checkpoints.some(({ event }) => event.kind === "verification" && event.keeperUntrashed),
        },
        recovery: attempt.releasedAt ? "released" : attempt.assessments.at(-1)?.classification === "verified-resolved" ? "verified-resolved" : isUnresolved(attempt) ? "quarantined" : "closed",
        assessment: attempt.assessments.at(-1) ?? null,
      })),
    } : null;
    return { ok: true, scope, run };
  }
  return {
    readRun,
    async run(options: ExecutionOptions, load: () => Promise<LoadedGroups>) {
      return exclusive(async (runId, scope) => {
        const results: ExecutionResult[] = [];
        const excludedGroups: ExecutionExclusion[] = [];
        let eligibleCount = 0, fetchedGroups = 0;
        const response = (stoppedEarly: boolean, stopReason: string | null) => ({
          ok: true, runId, dryRun: options.dryRun, scanLimit: options.scanLimit, executeLimit: options.executeLimit,
          fetchedGroups, eligibleCount, results, excludedGroups, stoppedEarly, stopReason,
          actuallyExecutedCount: results.filter((r) => r.executed).length,
          resolvedCount: results.filter((r) => r.resolvedDuplicate).length,
          trashedCount: results.filter((r) => r.trashedAsset).length,
        });
        try {
          journal.save({ version: 2, runId, scope, startedAt: new Date().toISOString(), finishedAt: null, attempts: [], report: null,
            context: { dryRun: options.dryRun, scanLimit: options.scanLimit, executeLimit: options.executeLimit, source: options.singleGroupId ? "single" : "batch", groupId: options.singleGroupId ?? null } });
          const policy = journal.exclusionIndex(scope);
          if (options.singleGroupId) {
            const excluded = exclusions(policy, { groupId: options.singleGroupId, assets: [] });
            if (excluded) {
              excludedGroups.push(excluded);
              throw new ExecutionServiceError(409, "group_excluded", "This group is processed or quarantined; inspect its recovery evidence", { runId, excludedGroups: [excluded] });
            }
          }
          const loaded = await load(); fetchedGroups = loaded.groups.length;
          const byId = new Map(loaded.decisions.map((decision) => [decision.groupId, decision]));
          const candidates = loaded.groups.flatMap((group) => {
            const decision = byId.get(group.groupId);
            const excluded = exclusions(policy, group);
            if (excluded) { excludedGroups.push(excluded); return []; }
            if (!decision || (!options.singleGroupId && !isExecutableDecision(decision))) return [];
            return [{ group, decision }];
          });
          eligibleCount = candidates.filter(({ decision }) => isExecutableDecision(decision)).length;
          if (options.singleGroupId && excludedGroups.length) throw new ExecutionServiceError(409, "group_excluded", "This group is processed or quarantined; inspect its recovery evidence", { runId, excludedGroups });
          let stoppedEarly = false, stopReason: string | null = null;
          for (const { group, decision } of candidates) {
            if (results.length >= options.executeLimit) break;
            // Recheck after previous attempts, including duplicates or regrouped assets in this request.
            const excluded = exclusions(policy, group);
            if (excluded) { excludedGroups.push(excluded); continue; }
            const attemptId = randomUUID();
            const attempt: RecoveryAttempt = { attemptId, runId, groupId: group.groupId, mode: options.dryRun ? "dry-run" : "execute",
              keepAssetId: decision.keepAssetId, trashAssetId: decision.trashAssetIds[0] ?? null,
              startedAt: new Date().toISOString(), checkpoints: [], result: null, assessments: [], releasedAt: null };
            const record = journal.run(scope, runId)!;
            record.attempts.push(attempt); journal.save(record);
            const executor = createDecisionExecutor(client, {
              delay: deps.delay,
              onCheckpoint: async (event) => { journal.checkpoint(scope, attemptId, event); },
            });
            let result: ExecutionResult;
            try { result = { ...await executor(group, decision, options.dryRun), runId, attemptId }; }
            catch (error) {
              if (error instanceof CheckpointFailure) results.push({ ...error.result, runId, attemptId });
              throw error;
            }
            results.push(result);
            journal.finish(scope, attemptId, result);
            if (result.outcome === "succeeded") policy.processed.add(group.groupId);
            try { log.appendExecutionLog({ timestamp: new Date().toISOString(), ...result }); }
            catch { stoppedEarly = true; stopReason = "Display log could not be written. The journal retains the result; batch stopped."; break; }
            if (result.outcome === "failed" || result.outcome === "needs-verification") {
              stoppedEarly = true; stopReason = `${result.groupId}: ${result.message}`; break;
            }
            await (deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(50);
          }
          const record = journal.run(scope, runId)!;
          record.finishedAt = new Date().toISOString();
          if (record.version === 2) record.report = { fetchedGroups, eligibleCount, excludedGroups, stoppedEarly, stopReason, requestError: null };
          journal.save(record);
          return { ...response(stoppedEarly, stopReason), decision: loaded.decisions[0] };
        } catch (error) {
          if (!(error instanceof JournalError) && !(error instanceof CheckpointFailure)) {
            try {
              const record = journal.run(scope, runId);
              if (record && record.attempts.every((attempt) => attempt.result !== null)) {
                record.finishedAt = new Date().toISOString();
                const failure: RunReport["requestError"] = error instanceof ExecutionServiceError
                  ? { status: error.status, code: error.code, message: error.message }
                  : { status: 500, code: "execution_error", message: "The run could not be completed; inspect the recorded evidence." };
                if (record.version === 2) record.report = { fetchedGroups, eligibleCount, excludedGroups, stoppedEarly: true, stopReason: failure.message, requestError: failure };
                journal.save(record);
              }
            } catch (failure) { error = failure; }
          }
          if (error instanceof JournalError || error instanceof CheckpointFailure) {
            const reason = "Recovery evidence could not be persisted. Execution stopped; preserve the journal and inspect partial results before retrying.";
            throw new ExecutionServiceError(503, "journal_unavailable", reason, { runId, results,
              partialExecution: { ...response(true, reason), ok: false } });
          }
          throw error;
        }
      });
    },
    clearLog() { return exclusive(async () => ({ clearedCount: log.clearExecutionLog(), path: log.getExecutionLogPath() })); },
    async list(offset = 0, limit = 25) {
      const storage = journal.health();
      let error = storage.error;
      try { if (storage.health === "ready") await identity(); } catch (failure) { lastScope = null; error = failure instanceof Error ? failure.message : "Identity unavailable"; }
      const items = storage.health === "ready" && lastScope ? unresolved(lastScope) : [];
      return { ok: !error, health: error ? "unavailable" as const : "ready" as const, error, activeRunId, scope: lastScope,
        items: items.slice(offset, offset + limit), total: items.length, offset, limit };
    },
    async detail(attemptId: string) {
      journal.initialize(); return findAttempt(await identity(), attemptId);
    },
    recheck(attemptId: string, release = false) {
      return exclusive(async (_, scope) => {
        const attempt = findAttempt(scope, attemptId);
        if (!isUnresolved(attempt)) throw new ExecutionServiceError(409, "attempt_closed", "This attempt is already resolved or released");
        const assessment = await reconcileAttempt(client, attempt, deps.delay);
        // Store every assessment, including a failed release request. Never discard prior evidence.
        const updated = journal.assess(scope, attemptId, assessment, release && assessment.classification === "pair-intact");
        if (release && assessment.classification !== "pair-intact") throw new ExecutionServiceError(409, "release_not_verified", "A fresh intact eligible pair could not be verified; no new attempt was allowed", { assessment });
        return updated;
      });
    },
  };
}
