import path from "node:path";
import { env } from "./config";
import { immich } from "./immich";
import { createApp } from "./app";
import { createExecutionJournal } from "./executionJournal";
import { createExecutionLog } from "./executionLog";
import { updateEnvFile } from "./settingsPersistence";
import { createRulesStore } from "./rulesStore";
import { createScanStore } from "./scanStore";

const app = createApp({
  immich,
  journal: createExecutionJournal(path.join(__dirname, "..", "data", "execution-journal")),
  rules: createRulesStore({ filePath: path.join(__dirname, "..", "data", "rules.json") }),
  scan: createScanStore({ filePath: path.join(__dirname, "..", "data", "scan-progress.json") }),
  config: env,
  log: createExecutionLog(path.join(__dirname, "..", "data", "execution-log.json")),
  fetch: globalThis.fetch,
  saveConnection: (updates) => updateEnvFile(path.resolve(process.cwd(), ".env"), updates),
});

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
