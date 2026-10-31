import { type Dispatch, type SetStateAction } from 'react';
import { type NavItemId } from './nav';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { DedupeScreen } from '../screens/DedupeScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { LogsScreen } from '../screens/LogsScreen';
import { RulesScreen } from '../screens/RulesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import type { SafetyConfig } from '../settings';
import type { ExecutionState } from '../useExecution';

type Props = {
  active: NavItemId;
  safety: SafetyConfig;
  onSafetyChange: Dispatch<SetStateAction<SafetyConfig>>;
  execution: ExecutionState;
  recoveryAttemptId: string | null;
  onReviewRecovery: (id: string) => void;
  onBackResults: () => void;
};

export function MainContent({ active, safety, onSafetyChange, execution, recoveryAttemptId, onReviewRecovery, onBackResults }: Props) {
  return (
    <main className="main-content">
      {active === 'welcome' && <WelcomeScreen />}
      {active === 'dedupe' && <DedupeScreen requireConfirmation={safety.requireConfirmation} execution={execution} onReviewRecovery={onReviewRecovery} />}
      {active === 'rules' && <RulesScreen snapshotId={execution.review?.planId ?? execution.quickSnapshot?.reviewId ?? null} disabled={execution.busy || execution.preparing || execution.loadingDetails || execution.selectingAll} onPublish={execution.rulesPublished} />}
      {active === 'history' && <HistoryScreen />}
      {active === 'logs' && <LogsScreen recoveryAttemptId={recoveryAttemptId} onBackResults={onBackResults} />}
      {active === 'settings' && <SettingsScreen safety={safety} onSafetyChange={onSafetyChange} />}
    </main>
  );
}
