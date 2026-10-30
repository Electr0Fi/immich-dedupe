import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type JournalFs = Pick<typeof fs,
  "mkdirSync" | "existsSync" | "readdirSync" | "readFileSync" | "openSync" |
  "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync"
>;

/** Commit a complete file; an interrupted write never replaces it with partial JSON. */
export function writeAtomicJson(file: string, value: unknown, io: JournalFs = fs) {
  const dir = path.dirname(file);
  io.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = io.openSync(temporary, "wx", 0o600);
  try {
    io.writeFileSync(fd, JSON.stringify(value, null, 2));
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  io.renameSync(temporary, file);
  const directory = io.openSync(dir, "r");
  try { io.fsyncSync(directory); } finally { io.closeSync(directory); }
}
