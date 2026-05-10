import { NAV_ITEMS, type NavItemId } from './nav';

type Props = {
  active: NavItemId;
  onNavigate: (id: NavItemId) => void;
};

export function Sidebar({ active, onNavigate }: Props) {
  return (
    <nav className="sidebar">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`sidebar__item${active === item.id ? ' sidebar__item--active' : ''}`}
          onClick={() => onNavigate(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
