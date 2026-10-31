import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRulesStore } from "../src/rulesStore";

const scope = { apiUrl: "https://immich.example/api", accountId: "user-a" };
test("rules store is lazy, returns copies and separates drafts from immutable published revisions", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rules-store-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json"); const store = createRulesStore({ filePath });
  assert.equal(fs.existsSync(filePath), false);
  const initial = await store.get(scope); initial.draft.rules[0].name = "Changed draft";
  assert.notEqual((await store.get(scope)).draft.rules[0].name, "Changed draft");
  await store.saveDraft(scope, initial.draft);
  assert.notEqual((await store.get(scope)).active.rules[0].name, "Changed draft");
  const published = await store.publish(scope);
  assert.equal(published.active.rules[0].name, "Changed draft");
  assert.notEqual(published.active.revision, initial.active.revision);
  const restarted = createRulesStore({ filePath });
  assert.deepEqual(await restarted.get(scope), published);
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.scopes[0].revisions.length, 2);
  assert.equal(persisted.scopes[0].revisions[0].rules[0].name, initial.active.rules[0].name);
});
test("account and server scopes remain independent and optimistic publication detects changes", async () => {
  const store = createRulesStore(); const state = await store.get(scope);
  state.draft.rules[0].name = "Custom";
  const published = await store.publish(scope, state.draft, state.active.revision);
  assert.notEqual(published.active.revision, state.active.revision);
  assert.notEqual((await store.get({ ...scope, accountId: "user-b" })).active.rules[0].name, "Custom");
  assert.notEqual((await store.get({ ...scope, apiUrl: "https://other.example/api" })).active.rules[0].name, "Custom");
  await assert.rejects(store.publish(scope, state.draft, state.active.revision), /Active rules changed/);
  await assert.rejects(store.get({ ...scope, apiUrl: "https://user:secret@immich.example/api" }), /credentials/);
});
test("malformed rules storage is preserved and never replaced with defaults", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rules-invalid-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json"); fs.writeFileSync(filePath, "broken{");
  const store = createRulesStore({ filePath });
  await assert.rejects(store.get(scope), /unreadable or invalid/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "broken{");
});
test("failed persistence does not activate draft or published changes", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rules-fault-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fail = false;
  const store = createRulesStore({ filePath: path.join(directory, "rules.json"), io: { ...fs, renameSync: (...args) => { if (fail) throw new Error("fault"); return fs.renameSync(...args); } } });
  const state = await store.get(scope); await store.saveDraft(scope, state.draft); fail = true;
  state.draft.rules[0].name = "Must not activate";
  await assert.rejects(store.publish(scope, state.draft), /could not be saved/);
  assert.notEqual((await store.get(scope)).active.rules[0].name, "Must not activate");
});
