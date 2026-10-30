import type {
  DuplicateDecision,
  DuplicateGroup,
  ExecutionResult,
} from "@immich-dedupe/shared";
import type { createDecisionExecutor } from "./executeDecision";
import type { ExecutionLog } from "./executionLog";

export function isExecutableDecision(decision: DuplicateDecision): boolean {
  return (
    decision.status === "auto-resolve" &&
    decision.confidence === 100 &&
    Boolean(decision.keepAssetId) &&
    decision.trashAssetIds.length === 1
  );
}

export function createPlanExecutor(dependencies: {
  executeDuplicateDecision: ReturnType<typeof createDecisionExecutor>;
  log: Pick<ExecutionLog, "appendExecutionLog" | "getProcessedGroupIds">;
}) {
  const { executeDuplicateDecision, log } = dependencies;
  const { appendExecutionLog, getProcessedGroupIds } = log;
  return async function executePlan(
    groups: DuplicateGroup[],
    decisions: DuplicateDecision[],
    executeLimit = 10,
    dryRun = false
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const processedIds = getProcessedGroupIds();
    const mode = dryRun ? "dry-run" : "execute";

    for (let i = 0; i < groups.length; i++) {
      if (results.length >= executeLimit) {
        break;
      }

      const group = groups[i];
      const decision = decisions[i];

      if (!group || !decision) continue;
      if (processedIds.has(group.groupId)) continue;
      if (!isExecutableDecision(decision)) continue;

      try {
        const result = await executeDuplicateDecision(group, decision, dryRun);

        appendExecutionLog({
          timestamp: new Date().toISOString(),
          groupId: group.groupId,
          mode,
          keepAssetId: result.keepAssetId,
          trashAssetId: result.trashAssetId,
          executed: result.executed,
          resolvedDuplicate: result.resolvedDuplicate,
          trashedAsset: result.trashedAsset,
          message: result.message,
        });

        results.push(result);

        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        const result: ExecutionResult = {
          groupId: group.groupId,
          mode,
          executed: false,
          keepAssetId: decision.keepAssetId,
          trashAssetId: decision.trashAssetIds[0] ?? null,
          transferredAlbumIds: [],
          skippedAlbumIds: [],
          resolvedDuplicate: false,
          trashedAsset: false,
          message:
            error instanceof Error ? error.message : "Unknown execution error",
        };

        appendExecutionLog({
          timestamp: new Date().toISOString(),
          groupId: result.groupId,
          mode: result.mode,
          keepAssetId: result.keepAssetId,
          trashAssetId: result.trashAssetId,
          executed: result.executed,
          resolvedDuplicate: result.resolvedDuplicate,
          trashedAsset: result.trashedAsset,
          message: result.message,
        });

        results.push(result);
      }
    }

    return results;
  };
}
