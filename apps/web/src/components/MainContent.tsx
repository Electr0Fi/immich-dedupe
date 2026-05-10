import { type NavItemId } from './nav';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { DedupeScreen } from '../screens/DedupeScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { LogsScreen } from '../screens/LogsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

type Props = {
  active: NavItemId;
};

export function MainContent({ active }: Props) {
  return (
    <main className="main-content">
      {active === 'welcome' && <WelcomeScreen />}
      {active === 'dedupe' && <DedupeScreen />}
      {active === 'history' && <HistoryScreen />}
      {active === 'logs' && <LogsScreen />}
      {active === 'settings' && <SettingsScreen />}
    </main>
  );
}
