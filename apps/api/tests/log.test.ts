import assert from 'node:assert/strict';
import { test } from 'node:test';
import { temporaryLog } from './fixtures';
import type { ExecutionLogEntry } from '../src/executionLog';

const success: ExecutionLogEntry = {
  timestamp: '2026-01-01T00:00:00.000Z', groupId: 'success', mode: 'execute',
  keepAssetId: 'keep', trashAssetId: 'trash', executed: true,
  resolvedDuplicate: true, trashedAsset: true, message: 'Done',
};

test('only fully successful live records mark a group processed, and clear removes tracking', (t) => {
  const log = temporaryLog(t);
  assert.deepEqual(log.loadExecutionLog(), []);
  const entries: ExecutionLogEntry[] = [
    success,
    { ...success, groupId: 'simulation', mode: 'dry-run' },
    { ...success, groupId: 'not-executed', executed: false },
    { ...success, groupId: 'unresolved', resolvedDuplicate: false },
    { ...success, groupId: 'untrashed', trashedAsset: false },
  ];
  for (const entry of entries) log.appendExecutionLog(entry);
  assert.deepEqual(log.loadExecutionLog(), entries);
  assert.deepEqual([...log.getProcessedGroupIds()], ['success']);
  assert.equal(log.clearExecutionLog(), entries.length);
  assert.deepEqual(log.loadExecutionLog(), []);
  assert.equal(log.getProcessedGroupIds().size, 0);
});
