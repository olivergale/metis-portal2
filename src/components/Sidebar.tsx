import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/manifold', icon: '◆', label: 'Manifold' },
  { to: '/agents',   icon: '✦', label: 'Agents' },
  { to: '/logs',     icon: '☰', label: 'Logs' },
  { to: '/health',   icon: '♥', label: 'Health' },
  { to: '/chat',     icon: '✉', label: 'Chat' },
  { to: '/kernel',   icon: '⬡', label: 'Kernel' },
];

export default function Sidebar() {
  return (
    <nav className="w-[220px] min-w-[220px] bg-surface border-r border-default flex flex-col h-screen">
      {/* Brand */}
      <div className="p-5 px-4 flex items-center gap-2.5 border-b border-default">
        <div className="w-7 h-7 rounded-md bg-accent text-white flex items-center justify-center font-bold text-sm">
          E
        </div>
        <span className="font-bold text-[15px] tracking-wide text-primary">
          ENDGAME
        </span>
      </div>

      {/* Navigation */}
      <div className="flex-1 p-3 px-2 flex flex-col gap-0.5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2.5 rounded-md text-[13px] font-medium transition-all no-underline ${
                isActive
                  ? 'bg-accent-subtle text-accent font-semibold'
                  : 'text-secondary hover:bg-hover'
              }`
            }
          >
            <span className="text-base w-5 text-center">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 px-4 border-t border-default">
        <span className="text-[11px] text-muted">
          Command Center v2
        </span>
      </div>
    </nav>
  );
}
