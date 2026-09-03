import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Button } from './ui';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/exports', label: 'Export History' },
  { to: '/exports/new', label: 'New Export' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="grid-backdrop min-h-full">
      <header className="sticky top-0 z-20 border-b border-vault-700/70 bg-vault-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <NavLink to="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 ring-1 ring-emerald-400/30">
              <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v13m0 0l-4-4m4 4l4-4M4 21h16" />
              </svg>
            </span>
            <span className="font-mono text-sm font-bold tracking-tight text-slate-100">
              Export<span className="text-emerald-400">Vault</span>
            </span>
          </NavLink>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/exports'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-vault-800 font-medium text-slate-100'
                      : 'text-slate-400 hover:bg-vault-850 hover:text-slate-200'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
              <div className="font-mono text-[11px] text-slate-500">{user?.email}</div>
            </div>
            <Button
              variant="ghost"
              className="py-1.5 text-xs"
              onClick={() => {
                logout();
                navigate('/login', { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
