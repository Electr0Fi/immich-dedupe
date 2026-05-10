export type NavItemId = 'welcome' | 'dedupe' | 'history' | 'logs' | 'settings';

export type NavItem = {
  id: NavItemId;
  label: string;
};

export const NAV_ITEMS: NavItem[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'dedupe', label: 'Dedupe' },
  { id: 'history', label: 'History' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];
