import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AssetRecord, DuplicateGroup, ExecutionScope } from "@immich-dedupe/shared";
import { createScanStore, scanGroupFingerprint, ScanStoreError } from "../src/scanStore";

const scope: ExecutionScope = { apiUrl: "http://immich.invalid/api", accountId: "user-a" };
function asset(id: string, groupId: string): AssetRecord {
  return { id, duplicateId: groupId, fileName: `${id}.jpg`, originalPath: `/photos/${id}.jpg`, originalMimeType: "image/jpeg",
    fileCreatedAt: "2024-01-01T00:00:00.000Z", fileModifiedAt: "2024-01-01T00:00:00.000Z", takenAt: "2024-01-01T00:00:00.000Z",
    width: 100, height: 100, checksum: "checksum", deviceId: null, deviceAssetId: null, libraryId: null, assetType: "IMAGE",
    isEdited: false, isTrashed: false, isFavorite: false, isArchived: false, isOffline: false, livePhotoVideoId: null,
    isExternal: false, isInternal: false, fileSize: 100, albums: [] };
}
function group(index: number): DuplicateGroup {
  const groupId = `group-${index}`;
  return { groupId, assets: [asset(`${index}-a`, groupId), asset(`${index}-b`, groupId)] };
}
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "immich-scan-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "scan.json"); const store = createScanStore({ filePath });
  return { store, filePath };
}
function exclude(store: ReturnType<typeof createScanStore>, item: DuplicateGroup, cacheable = true) {
  store.record(scope, item.groupId, { status: "excluded", reason: "Filename differs", cacheable });
}
function include(store: ReturnType<typeof createScanStore>, item: DuplicateGroup) {
  store.record(scope, item.groupId, { status: "eligible", reason: "Checksums match", keepAssetId: item.assets[0].id,
    trashAssetId: item.assets[1].id, comparisonClass: "checksum" });
}

test("excluded groups cannot saturate repeated scans after earlier successes disappear", (t) => {
  const { store } = setup(t); let groups = Array.from({ length: 400 }, (_, index) => group(index));
  const resolved = new Set<string>();
  for (let batch = 0; batch < 3; batch++) {
    store.begin(scope, "r1", groups);
    const checked: string[] = [];
    for (let i = 0; i < 100; i++) {
      const item = store.next(scope); assert.ok(item); checked.push(item.groupId);
      if (i < (batch === 0 ? 40 : 35)) exclude(store, item);
      else { include(store, item); resolved.add(item.groupId); }
    }
    assert.equal(checked[0], `group-${batch * 100}`);
    assert.equal(new Set(checked).size, 100);
    groups = groups.filter((item) => !resolved.has(item.groupId)).reverse();
  }
  assert.equal(store.get(scope).summary.excludedGroups, 110);
  assert.equal(store.get(scope).summary.remainingGroups, 100);
});

test("fresh ordering, asset ordering and disappearance preserve the unseen queue", (t) => {
  const { store } = setup(t); const groups = [group(0), group(1), group(2)];
  store.begin(scope, "r1", groups); exclude(store, groups[0]);
  store.begin(scope, "r1", [groups[2], { ...groups[0], assets: [...groups[0].assets].reverse() }, groups[1]]);
  assert.equal(store.next(scope)?.groupId, groups[1].groupId);
  store.begin(scope, "r1", [groups[0], groups[2]]);
  assert.equal(store.next(scope)?.groupId, groups[2].groupId);
  assert.equal(store.get(scope).summary.excludedGroups, 1);
});

test("new arrivals precede unchanged deferred work after the previous queue is exhausted", (t) => {
  const { store } = setup(t); const old = group(0), arrival = group(1);
  store.begin(scope, "r1", [old]);
  exclude(store, old, false);
  store.begin(scope, "r1", [old, arrival]);
  assert.equal(store.next(scope)?.groupId, arrival.groupId);
  exclude(store, arrival);
  assert.equal(store.next(scope)?.groupId, old.groupId);
});

test("metadata and membership changes become unreviewed behind existing unseen work", (t) => {
  const { store } = setup(t); const groups = [group(0), group(1)];
  store.begin(scope, "r1", groups); exclude(store, groups[0]);
  groups[0].assets[0].isFavorite = true;
  store.begin(scope, "r1", groups);
  assert.equal(store.next(scope)?.groupId, "group-1"); exclude(store, groups[1]);
  assert.equal(store.next(scope)?.groupId, "group-0"); exclude(store, groups[0]);
  groups[0].assets[0].id = "new-asset";
  store.begin(scope, "r1", groups);
  assert.equal(store.next(scope)?.assets[0].id, "new-asset");
});

test("publishing rules invalidates all classifications and pending proposals", (t) => {
  const { store } = setup(t); const groups = [group(0), group(1)];
  store.begin(scope, "r1", groups); exclude(store, groups[0]); include(store, groups[1]);
  assert.equal(store.getPending(scope).length, 1);
  const snapshot = store.begin(scope, "r2", groups);
  assert.equal(snapshot.summary.remainingGroups, 2); assert.equal(snapshot.pending.length, 0);
  assert.equal(snapshot.summary.excludedGroups, 0);
});

test("eligible groups stay pending across a dry-run and restart, but fresh list data is mandatory", (t) => {
  const { store, filePath } = setup(t); const groups = [group(0), group(1)];
  store.begin(scope, "r1", groups); include(store, groups[0]);
  const restored = createScanStore({ filePath });
  assert.equal(restored.getPending(scope)[0].keepAssetId, groups[0].assets[0].id);
  assert.throws(() => restored.next(scope), /Refresh the duplicate list/);
  const snapshot = restored.begin(scope, "r1", groups);
  assert.equal(snapshot.pending.length, 1); assert.equal(restored.next(scope)?.groupId, "group-1");
  restored.begin(scope, "r1", [groups[1]]);
  assert.equal(restored.getPending(scope).length, 0);
});

test("journal-authoritative group and asset exclusions override pending and cached work", (t) => {
  const { store } = setup(t); const groups = [group(0), group(1), group(2)];
  store.begin(scope, "r1", groups); include(store, groups[0]);
  const snapshot = store.begin(scope, "r1", groups, {
    blockedGroupIds: ["group-0"], blockedAssetIds: [groups[1].assets[0].id],
  });
  assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.summary.blockedGroups, 2);
  assert.equal(store.next(scope)?.groupId, "group-2");
});

test("unknown metadata, transient errors and enriched-only exclusions are reconsidered behind unseen work", (t) => {
  for (const status of ["deferred", "error", "excluded"] as const) {
    const { store } = setup(t); const groups = [group(0), group(1)];
    groups[0].assets[0].fileSize = null;
    store.begin(scope, "r1", groups); store.record(scope, "group-0", { status, reason: "Not verified", cacheable: false });
    store.begin(scope, "r1", groups);
    assert.equal(store.next(scope)?.groupId, "group-1"); exclude(store, groups[1]);
    assert.equal(store.next(scope)?.groupId, "group-0");
    groups[0].assets[0].fileSize = 100;
    store.begin(scope, "r1", groups);
    assert.equal(store.next(scope)?.assets[0].fileSize, 100);
  }
});

test("cancellation does not advance unfinished work; explicit recheck and reset affect scheduling only", (t) => {
  const { store } = setup(t); const groups = [group(0), group(1)];
  store.begin(scope, "r1", groups); assert.equal(store.next(scope)?.groupId, "group-0");
  assert.equal(store.next(scope)?.groupId, "group-0"); exclude(store, groups[0]); include(store, groups[1]);
  assert.equal(store.next(scope), null); store.recheckExcluded(scope);
  assert.equal(store.next(scope)?.groupId, "group-0"); assert.equal(store.getPending(scope).length, 1);
  assert.equal(store.reset(scope).summary.totalGroups, 0);
});

test("different accounts and servers cannot share proposals or scan progress", (t) => {
  const { store } = setup(t); const groups = [group(0)];
  store.begin(scope, "r1", groups); include(store, groups[0]);
  const otherAccount = { ...scope, accountId: "user-b" };
  const otherServer = { ...scope, apiUrl: "http://other.invalid/api" };
  assert.equal(store.getPending(otherAccount).length, 0); assert.equal(store.getPending(otherServer).length, 0);
  store.begin(otherAccount, "r1", groups); assert.equal(store.next(otherAccount)?.groupId, "group-0");
  store.reset(otherAccount); assert.equal(store.getPending(scope).length, 1);
  assert.equal(store.getPending({ ...scope, apiUrl: `${scope.apiUrl}/` }).length, 1);
});

test("malformed advisory storage is preserved until an explicit reset, without touching recovery files", (t) => {
  const { filePath } = setup(t); const raw = "broken advisory JSON";
  fs.writeFileSync(filePath, raw); const recovery = path.join(path.dirname(filePath), "journal.json");
  fs.writeFileSync(recovery, "immutable recovery evidence");
  const store = createScanStore({ filePath }); assert.throws(() => store.get(scope), ScanStoreError);
  assert.equal(fs.readFileSync(filePath, "utf8"), raw);
  store.resetAll(); assert.equal(store.get(scope).summary.totalGroups, 0);
  assert.equal(fs.readFileSync(recovery, "utf8"), "immutable recovery evidence");
});

test("construction is lazy and write failure does not advance a completed checkpoint", (t) => {
  const { filePath } = setup(t); let deny = false; let reads = 0;
  const store = createScanStore({ filePath, io: { ...fs,
    existsSync(file) { reads++; return fs.existsSync(file); },
    openSync(...args: Parameters<typeof fs.openSync>) { if (deny) throw new Error("disk failure"); return fs.openSync(...args); },
  } });
  assert.equal(reads, 0); const groups = [group(0)]; store.begin(scope, "r1", groups);
  deny = true; assert.throws(() => exclude(store, groups[0]), ScanStoreError);
  assert.equal(store.next(scope)?.groupId, "group-0");
});

test("buffered progress survives only after flush and never restores authorization", (t) => {
  const { store, filePath } = setup(t); const groups = [group(0), group(1)];
  store.begin(scope, "r1", groups);
  store.record(scope, "group-0", { status: "eligible", reason: "Checksums match", keepAssetId: groups[0].assets[0].id,
    trashAssetId: groups[0].assets[1].id }, { deferSave: true });
  assert.equal(store.getPending(scope).length, 1);
  const crashed = createScanStore({ filePath });
  assert.equal(crashed.getPending(scope).length, 0); assert.equal(crashed.get(scope).summary.remainingGroups, 2);
  store.flush(); const restored = createScanStore({ filePath });
  assert.equal(restored.getPending(scope).length, 1);
  assert.equal("planId" in restored.getPending(scope)[0], false);
  assert.throws(() => restored.next(scope), /Refresh the duplicate list/);
});

test("buffered flush failure is reported and preserves the last persisted progress", (t) => {
  const { filePath } = setup(t); let fail = false;
  const store = createScanStore({ filePath, io: { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) { if (fail) throw new Error("disk unavailable"); return fs.openSync(...args); },
  } });
  const groups = [group(0)]; store.begin(scope, "r1", groups);
  store.record(scope, "group-0", { status: "excluded", reason: "Different names", cacheable: true }, { deferSave: true });
  fail = true; assert.throws(() => store.flush(), ScanStoreError);
  const restored = createScanStore({ filePath }); assert.equal(restored.get(scope).summary.remainingGroups, 1);
  fail = false; store.flush(); assert.equal(createScanStore({ filePath }).get(scope).summary.excludedGroups, 1);
});

test("malformed repeated asset membership can be scheduled for a per-group exclusion", (t) => {
  const { store, filePath } = setup(t); const item = group(0); item.assets[1] = structuredClone(item.assets[0]);
  store.begin(scope, "r1", [item]);
  assert.equal(store.next(scope)?.assets.length, 2); exclude(store, item);
  assert.equal(createScanStore({ filePath }).get(scope).summary.excludedGroups, 1);
});

test("fingerprints ignore ordering and include protected metadata and album membership", () => {
  const one = group(0); one.assets[0].albums = [{ albumId: "b", albumName: "B" }, { albumId: "a", albumName: "A" }];
  const two = structuredClone(one); two.assets.reverse(); two.assets[1].albums.reverse();
  assert.equal(scanGroupFingerprint(one), scanGroupFingerprint(two));
  two.assets[0].isArchived = true;
  assert.notEqual(scanGroupFingerprint(one), scanGroupFingerprint(two));
});

test("duplicate IDs, invalid selections, capacity and credential-bearing scope URLs are rejected", (t) => {
  const { store } = setup(t); const item = group(0);
  assert.throws(() => store.begin(scope, "r1", [item, item]), /repeated/);
  store.begin(scope, "r1", [item]);
  assert.throws(() => store.record(scope, item.groupId, { status: "eligible", reason: "unsafe", keepAssetId: "missing", trashAssetId: "missing" }), /distinct assets/);
  assert.equal(store.next(scope)?.groupId, item.groupId);
  assert.throws(() => createScanStore({ maxGroups: 1 }).begin(scope, "r1", [group(0), group(1)]), /capacity/);
  assert.throws(() => store.begin({ ...scope, apiUrl: "http://user:secret@immich.invalid/api" }, "r1", [item]), /credential-free/);
});
