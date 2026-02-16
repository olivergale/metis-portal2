import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/manifold', icon: '\u25C6', label: 'Manifold' },
  { to: '/agents',   icon: '\u2726', label: 'Agents' },
  { to: '/logs',     icon: '\u2630', label: 'Logs' },
  { to: '/health',   icon: '\u2665', label: 'Health' },
  { to: '/chat',     icon: '\u2709', label: 'Chat' },
];

export default function Sidebar() {
  return (
    <nav style={styles.sidebar}>
      <div style={styles.brand}>
        <span style={styles.logo}>E</span>
        <span style={styles.brandText}>ENDGAME</span>
      </div>
      <div style={styles.nav}>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              ...styles.navItem,
              ...(isActive ? styles.navItemActive : {}),
            })}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
      <div style={styles.footer}>
        <span style={styles.footerText}>Command Center v2</span>
      </div>
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 'var(--sidebar-width)',
    minWidth: 'var(--sidebar-width)',
    background: 'var(--bg-surface)',
    borderRight: '1px solid var(--border-default)',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  brand: {
    padding: '20px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    borderBottom: '1px solid var(--border-default)',
  },
  logo: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--accent)',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 14,
  },
  brandText: {
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: '0.5px',
    color: 'var(--text-primary)',
  },
  nav: {
    flex: 1,
    padding: '12px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textDecoration: 'none',
    transition: 'all 0.15s',
  },
  navItemActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    fontWeight: 600,
  },
  navIcon: {
    fontSize: 16,
    width: 20,
    textAlign: 'center' as const,
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border-default)',
  },
  footerText: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
};
