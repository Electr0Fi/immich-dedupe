import { type Dispatch, type SetStateAction } from 'react';
import { type NavItemId } from './nav';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { DedupeScreen } from '../screens/DedupeScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { LogsScreen } from '../screens/LogsScreen';
import { SettingsScreen, type SafetyConfig } from '../screens/SettingsScreen';

type Props = {
  active: NavItemId;
  safety: SafetyConfig;
  onSafetyChange: Dispatch<SetStateAction<SafetyConfig>>;
};

export function MainContent({ active, safety, onSafetyChange }: Props) {
  return (
    <main className="main-content">
      {active === 'welcome' && <WelcomeScreen />}
      {active === 'dedupe' && <DedupeScreen requireConfirmation={safety.requireConfirmation} />}
      {active === 'history' && <HistoryScreen />}
      {active === 'logs' && <LogsScreen />}
      {active === 'settings' && <SettingsScreen safety={safety} onSafetyChange={onSafetyChange} />}
    </main>
  );
}
