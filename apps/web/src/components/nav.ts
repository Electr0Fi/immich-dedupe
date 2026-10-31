export type NavItemId = 'welcome' | 'dedupe' | 'history' | 'rules' | 'logs' | 'settings';

export type NavItem = {
  id: NavItemId;
  label: string;
};

export const NAV_ITEMS: NavItem[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'dedupe', label: 'Dedupe' },
  { id: 'rules', label: 'Rules' },
  { id: 'history', label: 'History' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];
