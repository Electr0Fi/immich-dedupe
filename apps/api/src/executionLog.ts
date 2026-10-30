import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ExecutionResult } from "@immich-dedupe/shared";

// New fields are optional so historical entries remain readable without migration.
export type ExecutionLogEntry = Partial<Pick<ExecutionResult,
  "runId" | "attemptId" | "outcome" | "failureStage" | "proposedAlbumIds" | "transferredAlbumIds" | "skippedAlbumIds"
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

    const schema = z.array(z.object({
      timestamp: z.string(), groupId: z.string().min(1), mode: z.enum(["execute", "dry-run"]),
      keepAssetId: z.string().nullable(), trashAssetId: z.string().nullable(),
      executed: z.boolean(), resolvedDuplicate: z.boolean(), trashedAsset: z.boolean(), message: z.string(),
    }).passthrough());
    try { return schema.parse(JSON.parse(fs.readFileSync(logPath, "utf-8"))) as ExecutionLogEntry[]; }
    catch { throw new Error("Execution log is invalid or unreadable; original file preserved"); }
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

  function getExecutionLogPath(): string {
    return logPath;
  }

  return { loadExecutionLog, appendExecutionLog, clearExecutionLog, getExecutionLogPath };
}

export type ExecutionLog = ReturnType<typeof createExecutionLog>;
