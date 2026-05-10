import fs from "fs";
import path from "path";

const DATA_DIR = path.join(__dirname, "..", "data");
const LOG_PATH = path.join(DATA_DIR, "execution-log.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export type ExecutionLogEntry = {
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

export function loadExecutionLog(): ExecutionLogEntry[] {
  ensureDataDir();
  if (!fs.existsSync(LOG_PATH)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
  } catch {
    return [];
  }
}

export function appendExecutionLog(entry: ExecutionLogEntry) {
  ensureDataDir();
  const existing = loadExecutionLog();
  existing.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(existing, null, 2));
}

export function clearExecutionLog(): number {
  ensureDataDir();
  const existing = loadExecutionLog();
  fs.writeFileSync(LOG_PATH, JSON.stringify([], null, 2));

  return existing.length;
}

export function getProcessedGroupIds(): Set<string> {
  return new Set(
    loadExecutionLog()
      .filter((entry) => entry.mode === "execute")
      .filter((entry) => entry.executed)
      .filter((entry) => entry.resolvedDuplicate)
      .filter((entry) => entry.trashedAsset)
      .map((entry) => entry.groupId)
  );
}

export function getExecutionLogPath(): string {
  return LOG_PATH;
}
