import path from "node:path";
import { env } from "./config";
import { immich } from "./immich";
import { createApp } from "./app";
import { createExecutionJournal } from "./executionJournal";
import { createExecutionLog } from "./executionLog";
import { updateEnvFile } from "./settingsPersistence";

const app = createApp({
  immich,
  journal: createExecutionJournal(path.join(__dirname, "..", "data", "execution-journal")),
  config: env,
  log: createExecutionLog(path.join(__dirname, "..", "data", "execution-log.json")),
  fetch: globalThis.fetch,
  saveConnection: (updates) => updateEnvFile(path.resolve(process.cwd(), ".env"), updates),
});

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
