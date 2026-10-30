import fs from "fs";
import path from "path";
import type { ExecutionResult } from "@immich-dedupe/shared";

// New fields are optional so historical entries remain readable without migration.
export type ExecutionLogEntry = Partial<Pick<ExecutionResult,
  "outcome" | "failureStage" | "proposedAlbumIds" | "transferredAlbumIds" | "skippedAlbumIds"
>> & {
  timestamp: string;
  groupId: string;
  mode: "dry-run" | "execute";
  keepAssetId: string | null;
  trashAssetId: string | null;
  executed: boolean;
  resolvedDuplicate: boolean;
  trashedAsset: boolean;
  message: string;
};

export function createExecutionLog(logPath: string) {
  const dataDir = path.dirname(logPath);
  function ensureDataDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }
  function loadExecutionLog(): ExecutionLogEntry[] {
    ensureDataDir();
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      return JSON.parse(fs.readFileSync(logPath, "utf-8"));
    } catch {
      return [];
    }
  }

  function appendExecutionLog(entry: ExecutionLogEntry) {
    ensureDataDir();
    const existing = loadExecutionLog();
    existing.push(entry);
    fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
  }

  function clearExecutionLog(): number {
    ensureDataDir();
    const existing = loadExecutionLog();
    fs.writeFileSync(logPath, JSON.stringify([], null, 2));

    return existing.length;
  }

  function getProcessedGroupIds(): Set<string> {
    return new Set(
      loadExecutionLog()
        .filter((entry) => entry.mode === "execute")
        .filter((entry) => entry.executed)
        .filter((entry) => entry.resolvedDuplicate)
        .filter((entry) => entry.trashedAsset)
        .map((entry) => entry.groupId)
    );
  }

  function getExecutionLogPath(): string {
    return logPath;
  }

  return { loadExecutionLog, appendExecutionLog, clearExecutionLog, getProcessedGroupIds, getExecutionLogPath };
}

export type ExecutionLog = ReturnType<typeof createExecutionLog>;
