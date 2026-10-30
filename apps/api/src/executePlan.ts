import type { DuplicateDecision, DuplicateGroup, ExecutionBatchResult, ExecutionResult } from "@immich-dedupe/shared";
import type { createDecisionExecutor } from "./executeDecision";
import type { ExecutionLog } from "./executionLog";

export function isExecutableDecision(decision: DuplicateDecision): boolean {
  return decision.status === "auto-resolve" && decision.confidence === 100 &&
    Boolean(decision.keepAssetId) && decision.trashAssetIds.length === 1;
}

export function createPlanExecutor(dependencies: {
  executeDuplicateDecision: ReturnType<typeof createDecisionExecutor>;
  log: Pick<ExecutionLog, "appendExecutionLog" | "getProcessedGroupIds">;
}) {
  const { executeDuplicateDecision, log } = dependencies;
  return async function executePlan(
    groups: DuplicateGroup[], decisions: DuplicateDecision[], executeLimit = 10, dryRun = true
  ): Promise<ExecutionBatchResult> {
    const results: ExecutionResult[] = [];
    const processedIds = log.getProcessedGroupIds();
    for (let i = 0; i < groups.length && results.length < executeLimit; i++) {
      const group = groups[i];
      const decision = decisions[i];
      if (!group || !decision || processedIds.has(group.groupId) || !isExecutableDecision(decision)) continue;

      let result: ExecutionResult;
      try {
        result = await executeDuplicateDecision(group, decision, dryRun);
      } catch (error) {
        // The executor normally returns structured failures. Unexpected exceptions are never success.
        result = {
          groupId: group.groupId, mode: dryRun ? "dry-run" : "execute",
          outcome: dryRun ? "failed" : "needs-verification", failureStage: "preflight",
          keepAssetId: decision.keepAssetId, trashAssetId: decision.trashAssetIds[0] ?? null,
          proposedAlbumIds: [], transferredAlbumIds: [], skippedAlbumIds: [],
          executed: false, resolvedDuplicate: false, trashedAsset: false,
          message: error instanceof Error ? error.message : "Unknown execution error",
        };
      }
      results.push(result);
      try {
        log.appendExecutionLog({ timestamp: new Date().toISOString(), ...result });
      } catch {
        return { results, stoppedEarly: true, stopReason: "Execution log could not be written; batch stopped. Inspect returned outcomes before retrying." };
      }
      if (result.outcome === "failed" || result.outcome === "needs-verification") {
        return { results, stoppedEarly: true, stopReason: `${result.groupId}: ${result.message}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { results, stoppedEarly: false, stopReason: null };
  };
}
