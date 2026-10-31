import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRulesStore, saveRulePresetSchema } from "../src/rulesStore";

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

test("presets persist complete rule sets separately from drafts and active revisions", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presets-store-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json"), store = createRulesStore({ filePath });
  const initial = await store.get(scope), ruleset = structuredClone(initial.draft);
  ruleset.rules.reverse(); ruleset.rules[0].name = "Custom rule contents";
  ruleset.rules[0].conditions = { all: [{ field: "fileName", operator: "same" }, { field: "width", operator: "between", value: [100, 800] }] };
  ruleset.rules[0].resolution = { all: [{ field: "originalPath", operator: "prefix", value: "/directory-a" }, { field: "fileSize", operator: "gt", compareTo: "other" }] };
  const result = await store.savePreset(scope, { name: "  My rules  ", ruleset });
  const saved = result.savedPresets.find((preset) => preset.name === "My rules")!;
  assert.deepEqual(saved.ruleset, ruleset);
  assert.deepEqual(result.draft, initial.draft); assert.deepEqual(result.active, initial.active);
  ruleset.rules[0].name = "Local edit";
  assert.notEqual((await store.get(scope)).savedPresets.find((preset) => preset.id === saved.id)!.ruleset.rules[0].name, "Local edit");
  assert.deepEqual((await createRulesStore({ filePath }).get(scope)).savedPresets, result.savedPresets);
  assert.equal((await store.get({ ...scope, accountId: "user-b" })).savedPresets.some((preset) => preset.id === saved.id), false);
});

test("preset overwrites require an explicit current target; new names create independent copies", async () => {
  const store = createRulesStore(), initial = await store.get(scope);
  const created = await store.savePreset(scope, { name: "Camera copies", ruleset: initial.draft });
  const preset = created.savedPresets.find((entry) => entry.name === "Camera copies")!;
  await assert.rejects(store.savePreset(scope, { name: " CAMERA COPIES ", ruleset: initial.draft }), /already exists/);
  const edited = structuredClone(initial.draft); edited.rules[0].name = "Modified content";
  const updated = await store.savePreset(scope, { name: "Camera copies", ruleset: edited, overwriteId: preset.id, expectedRevision: preset.revision });
  const overwritten = updated.savedPresets.find((entry) => entry.id === preset.id)!;
  assert.equal(overwritten.revision, 2); assert.deepEqual(overwritten.ruleset, edited);
  await assert.rejects(store.savePreset(scope, { name: "Camera copies", ruleset: initial.draft, overwriteId: preset.id, expectedRevision: 1 }), /changed or was deleted/);
  const copied = await store.savePreset(scope, { name: "Other camera", ruleset: edited });
  assert.equal(copied.savedPresets.length, updated.savedPresets.length + 1);
  assert.deepEqual(copied.savedPresets.find((entry) => entry.id === preset.id), overwritten);
  await assert.rejects(store.savePreset(scope, { name: "New target", ruleset: edited, overwriteId: preset.id, expectedRevision: 2 }), /changed or was deleted/);
  assert.equal(saveRulePresetSchema.safeParse({ name: "x", ruleset: initial.draft, overwriteId: preset.id }).success, false);
  assert.equal(saveRulePresetSchema.safeParse({ name: " ", ruleset: initial.draft }).success, false);
  assert.equal(saveRulePresetSchema.safeParse({ name: "x".repeat(101), ruleset: initial.draft }).success, false);
});

test("deleting every preset stays deleted across restart and never changes active rules or draft", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presets-delete-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json"), store = createRulesStore({ filePath });
  const initial = await store.get(scope);
  for (const preset of initial.savedPresets) {
    await assert.rejects(store.deletePreset(scope, preset.id, preset.revision + 1), /changed or was deleted/);
    await store.deletePreset(scope, preset.id, preset.revision);
  }
  const restarted = await createRulesStore({ filePath }).get(scope);
  assert.deepEqual(restarted.savedPresets, []); assert.deepEqual(restarted.active, initial.active); assert.deepEqual(restarted.draft, initial.draft);
  await assert.rejects(store.deletePreset(scope, initial.savedPresets[0].id, 1), /changed or was deleted/);
});

test("older rules files gain initial presets lazily without rewriting rules or revisions", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presets-old-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "rules.json"), store = createRulesStore({ filePath });
  const initial = await store.get(scope); await store.saveDraft(scope, initial.draft);
  const old = JSON.parse(fs.readFileSync(filePath, "utf8")); delete old.scopes[0].savedPresets;
  const text = JSON.stringify(old); fs.writeFileSync(filePath, text);
  const migrated = await createRulesStore({ filePath }).get(scope);
  assert.ok(migrated.savedPresets.length > 0); assert.deepEqual(migrated.active, initial.active); assert.deepEqual(migrated.draft, initial.draft);
  assert.equal(fs.readFileSync(filePath, "utf8"), text);
});

test("failed preset writes preserve saved contents and do not publish rules", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "presets-fault-")); context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fail = false;
  const store = createRulesStore({ filePath: path.join(directory, "rules.json"), io: { ...fs, renameSync: (...args) => { if (fail) throw new Error("fault"); return fs.renameSync(...args); } } });
  const initial = await store.get(scope); await store.saveDraft(scope, initial.draft); fail = true;
  await assert.rejects(store.savePreset(scope, { name: "Unsaved", ruleset: initial.draft }), /could not be saved/);
  const preset = initial.savedPresets[0];
  await assert.rejects(store.deletePreset(scope, preset.id, preset.revision), /could not be saved/);
  assert.deepEqual(await store.get(scope), initial);
});
