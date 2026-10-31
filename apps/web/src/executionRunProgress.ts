import type { ExecutionRunStage } from '@immich-dedupe/shared';

export const executionRunStageLabels: Record<ExecutionRunStage, string> = {
  'checking-history': 'Checking recovery history', 'checking-identity': 'Checking Immich account identity',
  'validating-selection': 'Validating the reviewed selection',
  'checking-membership': 'Checking fresh duplicate group membership', 'checking-assets': 'Checking fresh asset details and safety rules',
  'checking-albums': 'Checking album memberships and proposed transfers', 'saving-evidence': 'Saving recovery evidence',
  simulating: 'Simulating the resolution without changing Immich', 'transferring-albums': 'Adding the keeper to missing albums',
  'verifying-albums': 'Verifying keeper album memberships', 'resolving-duplicates': 'Resolving the duplicate and moving the loser to trash',
  'verifying-resolution': 'Verifying the keeper is retained and the loser is trashed and unlinked',
  'group-complete': 'Group attempt recorded', finalizing: 'Saving the final run report',
};
