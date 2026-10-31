import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DuplicateGroup, DuplicateDecision, ExecutionResult, ExecutionScope, ExecutionExclusion, RecoveryAttempt, RunView, RunViewResponse, RunReport, ReviewedRunEvidence, ReviewedCandidate, ReviewedPlanExclusion, ChangedPlanGroup, ReviewPreparationProgress, ReviewPreparationStage, ReviewPreparationResult, QuickReviewCandidate, QuickReviewExclusion, ExecutionRunProgress } from "@immich-dedupe/shared";
import { createDecisionExecutor, CheckpointFailure } from "./executeDecision";
import { isExecutableDecision } from "./executePlan";
import { JournalError, isUnresolved, sameScope, type ExecutionJournal } from "./executionJournal";
import { reconcileAttempt } from "./reconcileAttempt";
import type { ImmichClient } from "./immichClient";
import type { ExecutionLog } from "./executionLog";
import { createReviewedPlanStore, reviewedCandidate, currentCandidateSchema, candidateToGroup, changedCandidate } from "./reviewedPlan";
import { createQuickReviewStore, quickGroupListSchema, evaluateQuickGroup, changedQuickCandidate } from "./quickReview";
import { PrepareQuickSelectionSchema, CreatePlanSchema } from "./executionRequest";
import { readFreshPreflight, groupListSchema, PreflightSafetyError } from "./freshPreflight";
import { evaluateConfiguredGroup, evaluateDuplicateGroup, createRuleSet } from "@immich-dedupe/rule-engine";
import type { RuleSet, RuleSetDraft, CreateReviewedPlanRequest, SaveRulePresetRequest, QuickDetailProgress } from "@immich-dedupe/shared";
import { RulesStoreError, type RulesStore } from "./rulesStore";
import { ScanStoreError, type ScanStore } from "./scanStore";
import { normalizeDuplicates } from "./normalizeDuplicates";

export class ExecutionServiceError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export type ExecutionOptions = { dryRun: boolean; scanLimit: number; executeLimit: number; singleGroupId?: string };
class PreparationCancelled extends Error {}
type LoadedGroups = { groups: DuplicateGroup[]; decisions: DuplicateDecision[] };

export function normalizeApiUrl(value: string) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
export function createExecutionService(deps: {
  client: ImmichClient; apiUrl: string; journal: ExecutionJournal; log: ExecutionLog;
  delay?: (ms: number) => Promise<void>; now?: () => number;
  rules?: RulesStore; scan?: ScanStore;
}) {
  const { client, journal, log } = deps;
  const now = deps.now ?? Date.now;
  const plans = createReviewedPlanStore(now);
  const quickReviews = createQuickReviewStore(now);
  const ruleSnapshots = new Map<string, { scope: ExecutionScope; expiresAt: number; groups: DuplicateGroup[] }>();
  function saveRuleSnapshot(id: string, scope: ExecutionScope, groups: DuplicateGroup[]) {
    for (const [key, entry] of ruleSnapshots) if (entry.expiresAt <= now()) ruleSnapshots.delete(key);
    while (ruleSnapshots.size >= 40) ruleSnapshots.delete(ruleSnapshots.keys().next().value!);
    ruleSnapshots.set(id, { scope, expiresAt: now() + 15 * 60 * 1000, groups: structuredClone(groups) });
  }
  const preparations = new Map<string, { cancelled: boolean; finished: boolean; updatedAt: number }>();
  async function activeRules(scope: ExecutionScope) { return (await deps.rules?.get(scope, false))?.active; }
  function requireCurrentRules(ruleset?: RuleSet) {
    if (ruleset && ruleset.schemaVersion !== 2) throw new ExecutionServiceError(409, "resolution_upgrade_required", "Resolution rules were converted. Review the updated draft and publish rules before preparing or executing a new review.");
  }
  async function assertRevision(scope: ExecutionScope, ruleset?: RuleSet) {
    const active = await activeRules(scope);
    if (active && active.revision !== ruleset?.revision) throw new ExecutionServiceError(409, "rules_changed", "Rules changed; prepare a new review and complete a new dry-run");
  }
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
  async function exclusive<T>(action: (runId: string, scope: ExecutionScope) => Promise<T>, onStage?: (stage: "checking-history" | "checking-identity") => void): Promise<T> {
    if (activeRunId) throw new ExecutionServiceError(409, "execution_busy", "Another execution or recovery action is running", { activeRunId });
    const runId = randomUUID(); activeRunId = runId;
    try {
      onStage?.("checking-history");
      journal.initialize();
      onStage?.("checking-identity");
      const scope = await identity();
      onStage?.("checking-history");
      journal.migrate(scope, log.loadExecutionLog);
      return await action(runId, scope);
    } catch (error) {
      if (error instanceof ExecutionServiceError) throw error;
      if (error instanceof JournalError) throw new ExecutionServiceError(503, "journal_unavailable", error.message, { runId });
      if (error instanceof RulesStoreError || error instanceof ScanStoreError) throw new ExecutionServiceError(error instanceof RulesStoreError ? error.status : 503, "configuration_unavailable", error.message);
      throw new ExecutionServiceError(500, "execution_error", error instanceof Error ? error.message : "Execution failed", { runId });
    } finally { activeRunId = null; }
  }
  function exclusions(index: ReturnType<ExecutionJournal["exclusionIndex"]>, group: { groupId: string; assets: Array<{ id: string }> }): ExecutionExclusion | null {
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
      context: record.version !== 1 ? record.context : null, report: record.version !== 1 ? record.report : null,
      ...(record.version >= 3 && "review" in record ? { planId: record.review.planId, selectedCount: record.review.selectedGroupIds.length, authorizingDryRunId: record.review.authorizingDryRunId } : {}),
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
  async function runLocked(runId: string, scope: ExecutionScope, options: ExecutionOptions, load: () => Promise<LoadedGroups>, review?: ReviewedRunEvidence, notify?: (update: Partial<ExecutionRunProgress>) => void) {
    const results: ExecutionResult[] = [];
    const excludedGroups: ExecutionExclusion[] = [];
    let eligibleCount = 0, fetchedGroups = 0;
    const response = (stoppedEarly: boolean, stopReason: string | null) => ({
      ...(review ? { planId: review.planId, selectedCount: review.selectedGroupIds.length } : {}),
      ok: true, runId, dryRun: options.dryRun, scanLimit: options.scanLimit, executeLimit: options.executeLimit,
      fetchedGroups, eligibleCount, results, excludedGroups, stoppedEarly, stopReason,
      actuallyExecutedCount: results.filter((r) => r.executed).length,
      resolvedCount: results.filter((r) => r.resolvedDuplicate).length,
      trashedCount: results.filter((r) => r.trashedAsset).length,
    });
    try {
      notify?.({ stage: "saving-evidence" });
      const base = { runId, scope, startedAt: new Date(now()).toISOString(), finishedAt: null, attempts: [], report: null,
        context: { dryRun: options.dryRun, scanLimit: options.scanLimit, executeLimit: options.executeLimit, source: options.singleGroupId ? "single" as const : "batch" as const, groupId: options.singleGroupId ?? null } };
      journal.save(review ? { ...base, version: review.candidates.some((candidate) => candidate.ruleset?.schemaVersion === 2) ? 5 : review.candidates.some((candidate) => candidate.ruleset) ? 4 : 3, review } : { ...base, version: 2 });
      const policy = journal.exclusionIndex(scope);
      if (options.singleGroupId) {
        const excluded = exclusions(policy, { groupId: options.singleGroupId, assets: [] });
        if (excluded) {
          excludedGroups.push(excluded);
          throw new ExecutionServiceError(409, "group_excluded", "This group is processed or quarantined; inspect its recovery evidence", { runId, excludedGroups: [excluded] });
        }
      }
      const loaded = await load(); fetchedGroups = loaded.groups.length;
      const ruleset = await activeRules(scope);
      requireCurrentRules(ruleset);
      if (!review && ruleset) loaded.decisions = loaded.groups.map((group) => evaluateConfiguredGroup(group, ruleset));
      const byId = new Map(loaded.decisions.map((decision) => [decision.groupId, decision]));
      const candidates = loaded.groups.flatMap((group) => {
        const decision = byId.get(group.groupId);
        const excluded = exclusions(policy, group);
        if (excluded) {
          if (review) throw new ExecutionServiceError(409, "plan_changed", "Reviewed groups are now excluded; prepare a new review", { planId: review.planId, changedGroups: [{ groupId: group.groupId, reasons: [excluded.reason] }] });
          excludedGroups.push(excluded); return [];
        }
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
        if (excluded && !review) { excludedGroups.push(excluded); continue; }
        notify?.({ phase: "running", stage: "saving-evidence", groupId: group.groupId, groupIndex: results.length + 1, completedGroups: results.length });
        const attemptId = randomUUID();
        const attempt: RecoveryAttempt = { attemptId, runId, groupId: group.groupId, mode: options.dryRun ? "dry-run" : "execute",
          keepAssetId: decision.keepAssetId, trashAssetId: decision.trashAssetIds[0] ?? null,
          startedAt: new Date().toISOString(), checkpoints: [], result: null, assessments: [], releasedAt: null };
        const record = journal.run(scope, runId)!;
        record.attempts.push(attempt); journal.save(record);
        const executor = createDecisionExecutor(client, {
          ruleset,
          onStage: notify ? (stage) => notify({ stage }) : undefined,
          delay: deps.delay,
          validatePreflight: review ? (fresh) => {
            const index = journal.exclusionIndex(scope);
            index.blocked = index.blocked.filter((a) => a.attemptId !== attemptId);
            const excluded = exclusions(index, fresh.group);
            const original = review.candidates.find((c) => c.groupId === group.groupId)!;
            const differences = changedCandidate(original, reviewedCandidate(fresh, ruleset));
            if (excluded || differences.length) throw new PreflightSafetyError(`Reviewed data changed: ${excluded?.reason ?? differences.join("; ")}. Prepare a new review.`);
          } : undefined,
          onCheckpoint: async (event) => { journal.checkpoint(scope, attemptId, event); },
        });
        let result: ExecutionResult;
        try { result = { ...await executor(group, decision, options.dryRun), runId, attemptId }; }
        catch (error) {
          if (error instanceof CheckpointFailure) results.push({ ...error.result, runId, attemptId });
          if (error instanceof ExecutionServiceError) error.details = { runId, ...error.details };
      throw error;
        }
        results.push(result);
        journal.finish(scope, attemptId, result);
        notify?.({ stage: "group-complete", completedGroups: results.length });
        if (result.outcome === "succeeded") {
          policy.processed.add(group.groupId);
          // Advisory scheduling cannot change a durably verified execution outcome.
          // Subsequent pending reads filter against journal authority even if this write fails.
          try { deps.scan?.removePending(scope, [group.groupId]); } catch { /* Reconcile on the next scan. */ }
        }
        try { log.appendExecutionLog({ timestamp: new Date().toISOString(), ...result }); }
        catch { stoppedEarly = true; stopReason = "Display log could not be written. The journal retains the result; batch stopped."; break; }
        if (result.outcome === "failed" || result.outcome === "needs-verification") {
          stoppedEarly = true; stopReason = `${result.groupId}: ${result.message}`; break;
        }
        await (deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(50);
      }
      notify?.({ phase: "finalizing", stage: "finalizing", groupId: null, groupIndex: 0 });
      const record = journal.run(scope, runId)!;
      record.finishedAt = new Date().toISOString();
      if (record.version !== 1) record.report = { fetchedGroups, eligibleCount, excludedGroups, stoppedEarly, stopReason, requestError: null };
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
            if (record.version !== 1) record.report = { fetchedGroups, eligibleCount, excludedGroups, stoppedEarly: true, stopReason: failure.message, requestError: failure };
            journal.save(record);
          }
        } catch (failure) { error = failure; }
      }
      if (error instanceof JournalError || error instanceof CheckpointFailure) {
        const reason = "Recovery evidence could not be persisted. Execution stopped; preserve the journal and inspect partial results before retrying.";
        throw new ExecutionServiceError(503, "journal_unavailable", reason, { runId, results,
          partialExecution: { ...response(true, reason), ok: false } });
      }
      if (error instanceof ExecutionServiceError) error.details = { runId, ...error.details };
      throw error;
    }
  }
  async function checkReviewed(scope: ExecutionScope, candidates: ReviewedCandidate[], notify?: (update: Partial<ExecutionRunProgress>) => void) {
    const changedGroups: ChangedPlanGroup[] = [];
    const index = journal.exclusionIndex(scope);
    for (const [groupIndex, candidate] of candidates.entries()) {
      notify?.({ phase: "validating", stage: "checking-membership", groupId: candidate.groupId, groupIndex: groupIndex + 1 });
      const excluded = exclusions(index, candidateToGroup(candidate));
      if (excluded) { changedGroups.push({ groupId: candidate.groupId, reasons: [excluded.reason] }); continue; }
      try {
        const fresh = await readFreshPreflight(client, candidate.groupId, { keepId: candidate.keepAsset.id, trashId: candidate.trashAsset.id }, notify ? { checkCancelled() {}, stage: (stage) => notify({ stage }) } : undefined, { ruleset: candidate.ruleset });
        const reasons = changedCandidate(candidate, reviewedCandidate(fresh, candidate.ruleset));
        if (reasons.length) changedGroups.push({ groupId: candidate.groupId, reasons });
      } catch (error) {
        if (!(error instanceof PreflightSafetyError) && !(error instanceof z.ZodError)) throw new ExecutionServiceError(503, "preflight_unavailable", "Fresh Immich data could not be verified; prepare a new review");
        changedGroups.push({ groupId: candidate.groupId, reasons: [error instanceof PreflightSafetyError ? error.message : "Invalid fresh album or group information"] });
      }
    }
    return changedGroups;
  }
  async function prepareReview(options: { scanLimit: number; executeLimit: number; scan?: CreateReviewedPlanRequest["scan"] }, onProgress?: (progress: ReviewPreparationProgress) => void, quick = false): Promise<ReviewPreparationResult> {
    const preparationId = randomUUID();
    const state = { cancelled: false, finished: false, updatedAt: now() };
    let checkedGroups = 0, targetGroups: number | null = null;
    const candidates: ReviewedCandidate[] = [], excludedGroups: ReviewedPlanExclusion[] = [];
    const quickCandidates: QuickReviewCandidate[] = [], quickExcluded: QuickReviewExclusion[] = [];
    const observedGroups: DuplicateGroup[] = [];
    function progress(stage: ReviewPreparationStage) {
      // Reporting is observational: a disconnected/failed consumer cannot stop the coordinator.
      try { onProgress?.({ preparationId, stage, checkedGroups, targetGroups, eligibleGroups: quick ? quickCandidates.length : candidates.length, excludedGroups: quick ? quickExcluded.length : excludedGroups.length }); } catch { /* Ignore observer failures. */ }
    }
    function checkCancelled() { if (state.cancelled) throw new PreparationCancelled(); }
    return exclusive(async (_, scope) => {
      const parsed = CreatePlanSchema.safeParse(options);
      if (!parsed.success) throw new ExecutionServiceError(400, "invalid_plan", "Invalid review limits");
      let totalGroups = 0;
      const ruleset = await activeRules(scope);
      requireCurrentRules(ruleset);
      const scanning = !!options.scan && !!deps.scan;
      try {
        checkCancelled();
        progress("fetching-groups");
        let raw: unknown;
        try { raw = await client.getAssetDuplicates({}); }
        catch (error) {
          if (quick) throw new ExecutionServiceError(503, "preflight_unavailable", "Immich duplicate groups could not be loaded for Quick Review");
          throw error;
        }
        const quickParsed = quick || scanning || ruleset ? quickGroupListSchema.safeParse(raw) : null;
        if (quickParsed && !quickParsed.success) throw new ExecutionServiceError(503, "preflight_unavailable", "Immich returned invalid duplicate group data; no Quick Review was prepared");
        const quickGroups = quickParsed?.success ? quickParsed.data : null;
        const groups = quickGroups ?? groupListSchema.parse(raw);
        if (new Set(groups.map((g) => g.duplicateId)).size !== groups.length) throw new ExecutionServiceError(503, "preflight_unavailable", "Duplicate group information is inconsistent");
        const selected = groups.slice(0, options.scanLimit);
        totalGroups = groups.length; targetGroups = selected.length;
        checkCancelled();
        const index = journal.exclusionIndex(scope);
        if (scanning) {
          const normalized = normalizeDuplicates(quickGroups!).groups;
          normalized.forEach((group, gi) => group.assets.forEach((asset, ai) => {
            const value = quickGroups![gi].assets[ai].exifInfo?.fileSizeInByte;
            const size = value == null || (typeof value === "string" && !value.trim()) ? NaN : Number(value);
            asset.fileSize = Number.isFinite(size) && size > 0 ? size : null;
            // Missing linkage must stay visible to the advisory fingerprint.
            if (quickGroups![gi].assets[ai].livePhotoVideoId === undefined) asset.ruleMetadata = { ...asset.ruleMetadata, missingLivePhotoLink: 1 };
          }));
          await deps.scan!.begin(scope, ruleset?.revision ?? "legacy-1", normalized, {
            blockedGroupIds: [...index.processed, ...index.legacy, ...index.blocked.map((attempt) => attempt.groupId)],
            blockedAssetIds: index.blocked.flatMap((attempt) => [attempt.keepAssetId, attempt.trashAssetId].filter((id): id is string => id !== null)),
          });
          targetGroups = Math.min(options.scanLimit, deps.scan!.get(scope).summary.remainingGroups);
        }
        const rawById = new Map(groups.map((group) => [group.duplicateId, group]));
        for (let position = 0; position < options.scanLimit; position++) {
          if (options.scan?.mode === "candidates" && (quick ? quickCandidates.length : candidates.length) >= options.scan.candidateTarget!) break;
          const next = scanning ? deps.scan!.next(scope) : null;
          const group = scanning ? next && rawById.get(next.groupId) : selected[position];
          if (!group) break;
          checkCancelled();
          if (quickGroups) {
            const rawGroup = quickGroups.find((item) => item.duplicateId === group.duplicateId)!;
            const observed = normalizeDuplicates([rawGroup]).groups[0];
            observed.assets.forEach((asset, index) => {
              const size = rawGroup.assets[index].exifInfo?.fileSizeInByte;
              const parsed = size == null || (typeof size === "string" && !size.trim()) ? NaN : Number(size);
              asset.fileSize = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
            });
            observedGroups.push(observed);
          }
          if (!quick) progress("checking-membership");
          const excluded = exclusions(index, { groupId: group.duplicateId, assets: group.assets });
          if (quick) {
            if (excluded) quickExcluded.push({ ...excluded, message: `Excluded: ${excluded.reason}` });
            else {
              const result = evaluateQuickGroup(quickGroups!.find((item) => item.duplicateId === group.duplicateId)!, ruleset);
              if ('keepAsset' in result) quickCandidates.push(result); else quickExcluded.push(result);
            }
            if (scanning && !excluded) {
              const candidate = quickCandidates.find((item) => item.groupId === group.duplicateId);
              const exclusion = quickExcluded.find((item) => item.groupId === group.duplicateId);
              deps.scan!.record(scope, group.duplicateId, candidate ? { status: "eligible", reason: candidate.decision.reasons.join("; "), ruleName: candidate.decision.matchedRuleName, reasons: candidate.decision.reasons, keepAssetId: candidate.keepAsset.id, trashAssetId: candidate.trashAsset.id,
                comparisonClass: "evidenceClass" in candidate.decision ? String(candidate.decision.evidenceClass) : "metadata" } : {
                status: exclusion?.reason === "unverified" ? "deferred" : "excluded", reason: exclusion?.message ?? "Excluded", cacheable: exclusion?.reason !== "unverified", resolution: exclusion?.resolution, ruleName: exclusion?.ruleName,
              }, { deferSave: true });
            }
            checkedGroups++;
            if (scanning && checkedGroups % 25 === 0) deps.scan!.flush();
            progress("evaluating-rules");
            // Yield to HTTP cancellation requests without adding per-group network reads.
            if (checkedGroups % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
            continue;
          }
          if (excluded) excludedGroups.push({ ...excluded, message: `Excluded: ${excluded.reason}` });
          else {
            try {
              const fresh = await readFreshPreflight(client, group.duplicateId, undefined, { checkCancelled, stage: progress }, { ruleset, ...(ruleset ? { memberships: groups } : {}) });
              const candidate = reviewedCandidate(fresh, ruleset);
              currentCandidateSchema.parse(candidate);
              checkCancelled();
              candidates.push(candidate);
              const observedIndex = observedGroups.findIndex((item) => item.groupId === group.duplicateId);
              if (observedIndex >= 0) observedGroups[observedIndex] = fresh.group;
            } catch (error) {
              if (error instanceof PreparationCancelled) throw error;
              if (!(error instanceof PreflightSafetyError)) throw new ExecutionServiceError(503, "preflight_unavailable", "Fresh Immich data could not be verified; no review was prepared");
              checkCancelled();
              const observedIndex = observedGroups.findIndex((item) => item.groupId === group.duplicateId);
              if (error.group && observedIndex >= 0) observedGroups[observedIndex] = error.group;
              excludedGroups.push({ groupId: group.duplicateId, reason: error.classification === "deferred" ? "unverified" : "ineligible", message: error.message, attemptIds: [], ...(error.decision?.resolution ? { resolution: error.decision.resolution, ruleName: error.decision.matchedRuleName } : {}) });
            }
          }
          if (scanning && !excluded) {
            const candidate = candidates.find((item) => item.groupId === group.duplicateId);
            deps.scan!.record(scope, group.duplicateId, candidate ? { status: "eligible", reason: candidate.decision.reasons.join("; "), ruleName: candidate.decision.matchedRuleName, reasons: candidate.decision.reasons, keepAssetId: candidate.keepAsset.id, trashAssetId: candidate.trashAsset.id,
              comparisonClass: "evidenceClass" in candidate.decision ? String(candidate.decision.evidenceClass) : "metadata" } : {
              status: excludedGroups.find((item) => item.groupId === group.duplicateId)?.reason === "unverified" ? "deferred" : "excluded", reason: excludedGroups.find((item) => item.groupId === group.duplicateId)?.message ?? "Excluded", cacheable: false, resolution: excludedGroups.find((item) => item.groupId === group.duplicateId)?.resolution, ruleName: excludedGroups.find((item) => item.groupId === group.duplicateId)?.ruleName,
            }, { deferSave: true });
          }
          checkedGroups++;
          if (scanning && checkedGroups % 25 === 0) deps.scan!.flush();
          progress("checking-membership");
        }
      } catch (error) { if (!(error instanceof PreparationCancelled)) throw error; }
      finally { if (scanning) deps.scan!.flush(); }
      const status = state.cancelled ? "cancelled" as const : "completed" as const;
      progress("finalizing");
      const scan = scanning ? deps.scan!.get(scope) : undefined;
      if (scan) scan.preparation = { mode: options.scan!.mode, checkedThisRequest: checkedGroups, foundThisRequest: quick ? quickCandidates.length : candidates.length,
        stopReason: state.cancelled ? "cancelled" : options.scan?.mode === "candidates" && (quick ? quickCandidates.length : candidates.length) >= options.scan.candidateTarget! ? "target-reached" : scan.summary.remainingGroups === 0 ? "snapshot-exhausted" : "inspection-budget" };
      if (quick) {
        const quickReview = targetGroups === null ? null : quickReviews.put({ scope, ...(ruleset ? { ruleset } : {}), ...(scan ? { scan } : {}), scanLimit: options.scanLimit, executeLimit: options.executeLimit, fetchedGroups: checkedGroups, totalGroups,
          candidates: quickCandidates, excludedGroups: quickExcluded, preparation: { status, checkedGroups, targetGroups } });
        if (quickReview) saveRuleSnapshot(quickReview.reviewId, scope, observedGroups.slice(0, checkedGroups));
        return { status, plan: null, quickReview };
      }
      const plan = targetGroups === null ? null : plans.put({ scope, ...(ruleset ? { ruleset } : {}), ...(scan ? { scan } : {}), scanLimit: options.scanLimit, executeLimit: options.executeLimit, fetchedGroups: checkedGroups, totalGroups, candidates, excludedGroups,
        preparation: { status, checkedGroups, targetGroups } });
      if (plan) saveRuleSnapshot(plan.planId, scope, observedGroups.slice(0, checkedGroups));
      return { status, plan };
    }, (stage) => {
      if (!preparations.has(preparationId)) {
        for (const [id, entry] of preparations) if (entry.finished && now() - entry.updatedAt >= 15 * 60 * 1000) preparations.delete(id);
        while (preparations.size >= 20) preparations.delete(preparations.keys().next().value!);
        preparations.set(preparationId, state);
      }
      progress(stage);
    }).finally(() => { state.finished = true; state.updatedAt = now(); });
  }
  return {
    readRun,
    async evaluateGroups(groups: DuplicateGroup[]) {
      const ruleset = await activeRules(await identity());
      return groups.map((group) => ruleset ? evaluateConfiguredGroup(group, ruleset) : evaluateDuplicateGroup(group));
    },
    rulesState() { return exclusive(async (_, scope) => {
      if (!deps.rules) throw new ExecutionServiceError(503, "rules_unavailable", "Rule configuration is unavailable");
      return { ok: true as const, ...await deps.rules.get(scope) };
    }); },
    saveRules(draft: RuleSetDraft, publish = false) { return exclusive(async (_, scope) => {
      if (!deps.rules) throw new ExecutionServiceError(503, "rules_unavailable", "Rule configuration is unavailable");
      const state = publish ? await deps.rules.publish(scope, draft) : await deps.rules.saveDraft(scope, draft);
      // Revision checks reject old plans even if a browser keeps their IDs.
      return { ok: true as const, ...state };
    }); },
    savePreset(request: SaveRulePresetRequest) { return exclusive(async (_, scope) => {
      if (!deps.rules) throw new ExecutionServiceError(503, "rules_unavailable", "Rule configuration is unavailable");
      return { ok: true as const, ...await deps.rules.savePreset(scope, request) };
    }); },
    deletePreset(id: string, expectedRevision: number) { return exclusive(async (_, scope) => {
      if (!deps.rules) throw new ExecutionServiceError(503, "rules_unavailable", "Rule configuration is unavailable");
      return { ok: true as const, ...await deps.rules.deletePreset(scope, id, expectedRevision) };
    }); },
    testRules(snapshotId: string, draft: RuleSetDraft) { return exclusive(async (_, scope) => {
      const plan = plans.get(snapshotId)?.plan;
      const quick = quickReviews.get(snapshotId);
      const snapshot = plan ?? quick;
      if (!snapshot || !sameScope(scope, snapshot.scope)) throw new ExecutionServiceError(410, "snapshot_unavailable", "Prepare a review for this connection before testing rules");
      const ruleset = createRuleSet(draft);
      const observed = ruleSnapshots.get(snapshotId);
      if (observed && observed.expiresAt > now() && sameScope(scope, observed.scope)) return { ok: true as const, results: observed.groups.map((group) => evaluateConfiguredGroup(group, ruleset)) };
      return { ok: true as const, results: snapshot.candidates.map((candidate) => evaluateConfiguredGroup(candidateToGroup({ ...candidate,
        keepAsset: { ...candidate.keepAsset, albums: "albums" in candidate.keepAsset ? candidate.keepAsset.albums : [] },
        trashAsset: { ...candidate.trashAsset, albums: "albums" in candidate.trashAsset ? candidate.trashAsset.albums : [] },
      }), ruleset)) };
    }); },
    scanPending() { return exclusive(async (_, scope) => {
      const snapshot = deps.scan?.get(scope);
      const ruleset = await activeRules(scope);
      const policy = journal.exclusionIndex(scope);
      const pending = (snapshot?.pending ?? []).filter((item) => (!ruleset || item.rulesetRevision === ruleset.revision) &&
        !exclusions(policy, { groupId: item.groupId, assets: [{ id: item.keepAssetId }, { id: item.trashAssetId }] }));
      const summary = snapshot?.summary;
      if (summary) {
        summary.pendingCandidates = pending.length;
        if (ruleset && summary.rulesetRevision !== ruleset.revision) Object.assign(summary, {
          rulesetRevision: ruleset.revision, visitedGroups: 0, excludedGroups: 0, deferredGroups: 0,
          remainingGroups: summary.totalGroups - summary.blockedGroups,
        });
      }
      const conflicts = (snapshot?.conflicts ?? []).filter((item) => (!ruleset || item.rulesetRevision === ruleset.revision) && !exclusions(policy, { groupId: item.groupId, assets: item.assessment.assets }));
      return { ok: true as const, pending, summary, conflicts };
    }); },
    resetScan(recheck = false) { return exclusive(async (_, scope) => {
      if (!deps.scan) throw new ExecutionServiceError(503, "scan_unavailable", "Scan progress is unavailable");
      const snapshot = recheck ? deps.scan.recheckExcluded(scope) : deps.scan.reset(scope);
      return { ok: true as const, ...snapshot };
    }); },
    preparePending(request: unknown) { return exclusive(async (_, scope) => {
      const parsed = PrepareQuickSelectionSchema.safeParse(request);
      if (!parsed.success || !deps.scan) throw new ExecutionServiceError(400, "invalid_selection", "Select pending groups within a positive Execute Limit");
      const { selectedGroupIds, executeLimit } = parsed.data;
      if (selectedGroupIds.length > executeLimit) throw new ExecutionServiceError(400, "invalid_selection", "Selection exceeds Execute Limit");
      const ruleset = await activeRules(scope); requireCurrentRules(ruleset); const pending = deps.scan.getPending(scope), index = journal.exclusionIndex(scope);
      const candidates: ReviewedCandidate[] = [];
      for (const groupId of selectedGroupIds) {
        const proposal = pending.find((item) => item.groupId === groupId);
        if (!proposal || (ruleset && proposal.rulesetRevision !== ruleset.revision)) throw new ExecutionServiceError(409, "pending_changed", "Pending candidates changed; continue scanning to refresh them");
        if (exclusions(index, { groupId, assets: [{ id: proposal.keepAssetId }, { id: proposal.trashAssetId }] })) throw new ExecutionServiceError(409, "group_excluded", "A selected pending candidate is processed or quarantined");
        try {
          const fresh = await readFreshPreflight(client, groupId, { keepId: proposal.keepAssetId, trashId: proposal.trashAssetId }, { checkCancelled() {}, stage() {} }, { ruleset });
          const candidate = reviewedCandidate(fresh, ruleset);
          currentCandidateSchema.parse(candidate); candidates.push(candidate);
        } catch (error) {
          if (error instanceof PreflightSafetyError || error instanceof z.ZodError) throw new ExecutionServiceError(409, "pending_changed", "A selected pending candidate changed; prepare a new review");
          throw new ExecutionServiceError(503, "preflight_unavailable", "Pending candidate details could not be verified; pending results were preserved");
        }
      }
      return { ok: true as const, plan: plans.put({ scope, ruleset, scanLimit: candidates.length, executeLimit, fetchedGroups: candidates.length, totalGroups: deps.scan.get(scope).summary.totalGroups, candidates, excludedGroups: [] }) };
    }); },
    run(options: ExecutionOptions, load: () => Promise<LoadedGroups>) {
      return exclusive((runId, scope) => runLocked(runId, scope, options, load));
    },
    async preparePlan(options: { scanLimit: number; executeLimit: number; scan?: CreateReviewedPlanRequest["scan"] }) {
      const result = await prepareReview(options);
      return { ok: true as const, plan: result.plan! };
    },
    preparePlanStream: prepareReview,
    prepareQuickReview(options: { scanLimit: number; executeLimit: number; scan?: CreateReviewedPlanRequest["scan"] }, onProgress?: (progress: ReviewPreparationProgress) => void) {
      return prepareReview(options, onProgress, true);
    },
    prepareQuickSelection(reviewId: string, request: unknown, onProgress?: (progress: QuickDetailProgress) => void) {
      const parsed = PrepareQuickSelectionSchema.safeParse(request);
      let progress: QuickDetailProgress = { reviewId, stage: 'checking-history', groupId: null,
        groupIndex: 0, totalGroups: parsed.success ? parsed.data.selectedGroupIds.length : 0, checkedGroups: 0 };
      const notify = (update: Partial<QuickDetailProgress>) => {
        progress = { ...progress, ...update };
        try { onProgress?.(structuredClone(progress)); } catch { /* Observations cannot interrupt reads or release the coordinator. */ }
      };
      return exclusive(async (_, scope) => {
        notify({ stage: 'validating-selection' });
        if (!parsed.success) throw new ExecutionServiceError(400, "invalid_selection", "Select unique provisional candidates within a positive Execute Limit");
        const snapshot = quickReviews.get(reviewId);
        if (!snapshot) throw new ExecutionServiceError(410, "quick_review_unavailable", "Quick Review expired or is unavailable; prepare a new review");
        if (!sameScope(snapshot.scope, scope)) throw new ExecutionServiceError(409, "plan_scope_changed", "The Immich connection changed; prepare a new review");
        await assertRevision(scope, snapshot.ruleset);
        const { selectedGroupIds, executeLimit } = parsed.data;
        const selected = snapshot.candidates.filter((candidate) => selectedGroupIds.includes(candidate.groupId));
        if (selected.length !== selectedGroupIds.length || selected.length > executeLimit) throw new ExecutionServiceError(400, "invalid_selection", "Select only provisional candidates within Execute Limit");
        const index = journal.exclusionIndex(scope), candidates: ReviewedCandidate[] = [], changedGroups: ChangedPlanGroup[] = [];
        for (const [groupIndex, expected] of selected.entries()) {
          notify({ stage: 'checking-membership', groupId: expected.groupId, groupIndex: groupIndex + 1 });
          const excluded = exclusions(index, { groupId: expected.groupId, assets: [expected.keepAsset, expected.trashAsset] });
          if (excluded) { changedGroups.push({ groupId: expected.groupId, reasons: [excluded.reason] }); notify({ checkedGroups: groupIndex + 1 }); continue; }
          try {
            // Use preparation read batching so failures also await all started reads before unlocking.
            const fresh = await readFreshPreflight(client, expected.groupId, { keepId: expected.keepAsset.id, trashId: expected.trashAsset.id }, { checkCancelled() {}, stage: (stage) => notify({ stage }) }, { ruleset: snapshot.ruleset });
            notify({ stage: 'evaluating-rules' });
            const candidate = reviewedCandidate(fresh, snapshot.ruleset);
            currentCandidateSchema.parse(candidate);
            const reasons = changedQuickCandidate(expected, candidate);
            if (reasons.length) changedGroups.push({ groupId: expected.groupId, reasons }); else candidates.push(candidate);
          } catch (error) {
            if (error instanceof PreflightSafetyError || error instanceof z.ZodError) changedGroups.push({ groupId: expected.groupId, reasons: [error instanceof PreflightSafetyError ? error.message : "Invalid fresh group or album data"] });
            else throw new ExecutionServiceError(503, "preflight_unavailable", "Selected group details could not be verified; Quick Review results were preserved");
          }
          notify({ checkedGroups: groupIndex + 1 });
        }
        if (changedGroups.length) throw new ExecutionServiceError(409, "plan_changed", "Selected quick results changed; prepare a new review", { changedGroups });
        notify({ stage: 'finalizing', groupId: null, groupIndex: 0 });
        return { ok: true as const, plan: plans.put({ scope, ruleset: snapshot.ruleset, scanLimit: snapshot.scanLimit, executeLimit, fetchedGroups: candidates.length,
          totalGroups: snapshot.totalGroups, candidates, excludedGroups: [] }) };
      }, onProgress ? (stage) => notify({ stage }) : undefined);
    },
    selectAllReviewed(planId: string) {
      return exclusive(async (_, scope) => {
        const entry = plans.get(planId);
        if (!entry) throw new ExecutionServiceError(410, "plan_unavailable", "Review expired or is unavailable");
        if (!sameScope(entry.plan.scope, scope)) throw new ExecutionServiceError(409, "plan_scope_changed", "The Immich connection changed");
        const plan = entry.plan;
        await assertRevision(scope, plan.ruleset);
        // Keep the reviewed snapshot and its deadline; never carry dry-run authorization to a new plan.
        return { ok: true as const, plan: plans.put({
          scope: plan.scope, ruleset: plan.ruleset, scan: plan.scan, scanLimit: plan.scanLimit, executeLimit: Math.max(plan.executeLimit, plan.candidates.length),
          fetchedGroups: plan.fetchedGroups, totalGroups: plan.totalGroups, candidates: plan.candidates,
          excludedGroups: plan.excludedGroups, ...(plan.preparation ? { preparation: plan.preparation } : {}),
        }, { createdAt: plan.createdAt, expiresAt: plan.expiresAt }) };
      });
    },
    cancelPreparation(preparationId: string) {
      const state = preparations.get(preparationId);
      if (!state || (state.finished && now() - state.updatedAt >= 15 * 60 * 1000)) throw new ExecutionServiceError(404, "preparation_not_found", "Review preparation is no longer available");
      if (!state.finished) state.cancelled = true;
      return { ok: true as const, status: state.finished ? "finished" as const : "cancelling" as const };
    },
    runReviewed(planId: string, request: { selectedGroupIds: string[]; dryRun?: boolean }, onProgress?: (progress: ExecutionRunProgress) => void) {
      let progress: ExecutionRunProgress = { runId: null, dryRun: request?.dryRun !== false, phase: "validating", stage: "checking-history",
        groupId: null, groupIndex: 0, totalGroups: Array.isArray(request?.selectedGroupIds) ? request.selectedGroupIds.length : 0, completedGroups: 0 };
      const notify = (update: Partial<ExecutionRunProgress>) => {
        progress = { ...progress, ...update, runId: activeRunId };
        try { onProgress?.(structuredClone(progress)); } catch { /* Observers never affect journal authority or mutations. */ }
      };
      return exclusive(async (runId, scope) => {
        notify({ stage: "validating-selection" });
        const parsed = z.object({ selectedGroupIds: z.array(z.string().min(1)).nonempty().refine((ids) => new Set(ids).size === ids.length), dryRun: z.boolean().default(true) }).strict().safeParse(request);
        if (!parsed.success) throw new ExecutionServiceError(400, "invalid_selection", "Select unique eligible groups and a boolean dryRun mode");
        const entry = plans.get(planId);
        if (!entry) throw new ExecutionServiceError(410, "plan_unavailable", "Review expired, was consumed, or is unavailable; prepare a new review");
        if (!sameScope(entry.plan.scope, scope)) throw new ExecutionServiceError(409, "plan_scope_changed", "The Immich connection changed; prepare a new review");
        await assertRevision(scope, entry.plan.ruleset);
        const { selectedGroupIds, dryRun } = parsed.data;
        const candidates = entry.plan.candidates.filter((c) => selectedGroupIds.includes(c.groupId));
        if (candidates.length !== selectedGroupIds.length || candidates.length > entry.plan.executeLimit) throw new ExecutionServiceError(400, "invalid_selection", "Selection must contain eligible reviewed groups within the attempt limit");
        const orderedIds = candidates.map((c) => c.groupId);
        if (!dryRun && (!entry.authorization || JSON.stringify(entry.authorization.selectedGroupIds) !== JSON.stringify(orderedIds))) throw new ExecutionServiceError(409, "dry_run_required", "Complete a successful dry-run of this exact selection before live execution");
        const review: ReviewedRunEvidence = { planId, createdAt: entry.plan.createdAt, expiresAt: entry.plan.expiresAt,
          selectedGroupIds: orderedIds, candidates: structuredClone(candidates), authorizingDryRunId: dryRun ? null : entry.authorization!.runId };
        entry.authorization = null;
        if (!dryRun) plans.remove(planId);
        try {
          const result = await runLocked(runId, scope, { ...entry.plan, dryRun }, async () => {
            const changedGroups = await checkReviewed(scope, candidates, onProgress ? notify : undefined);
            if (changedGroups.length) throw new ExecutionServiceError(409, "plan_changed", "Reviewed data changed; prepare a new review", { planId, changedGroups });
            return { groups: candidates.map(candidateToGroup), decisions: candidates.map((c) => c.decision) };
          }, review, onProgress ? notify : undefined);
          if (dryRun && !result.stoppedEarly && result.results.length === candidates.length && result.results.every((r) => r.outcome === "dry-run")) entry.authorization = { selectedGroupIds: orderedIds, runId };
          else plans.remove(planId);
          return result;
        } catch (error) { plans.remove(planId); throw error; }
      }, onProgress ? (stage) => notify({ stage }) : undefined);
    },
    reviewedAsset(planId: string, assetId: string) {
      return identity().then((scope) => {
        const entry = plans.get(planId);
        if (!entry) throw new ExecutionServiceError(410, "plan_unavailable", "Review expired or is unavailable");
        if (!sameScope(entry.plan.scope, scope)) throw new ExecutionServiceError(409, "plan_scope_changed", "The Immich connection changed");
        if (!entry.plan.candidates.some((c) => c.keepAsset.id === assetId || c.trashAsset.id === assetId)) throw new ExecutionServiceError(404, "asset_not_reviewed", "Asset is not in this review");
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
        const assessment = await reconcileAttempt(client, attempt, deps.delay, await activeRules(scope));
        // Store every assessment, including a failed release request. Never discard prior evidence.
        const updated = journal.assess(scope, attemptId, assessment, release && assessment.classification === "pair-intact");
        if (release && assessment.classification !== "pair-intact") throw new ExecutionServiceError(409, "release_not_verified", "A fresh intact eligible pair could not be verified; no new attempt was allowed", { assessment });
        return updated;
      });
    },
  };
}
