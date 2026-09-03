import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  {
    to: '/dashboard',
    label: 'Dashboard',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 8.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 018.25 20.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
      />
    ),
  },
  {
    to: '/exports',
    label: 'Export History',
    end: true,
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 9.75h16.5M3.75 14.25h16.5M5.25 4.5h13.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z"
      />
    ),
  },
  {
    to: '/exports/new',
    label: 'New Export',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    ),
  },
];

function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 ring-1 ring-emerald-400/30">
        <svg
          className="h-4 w-4 text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v13m0 0l-4-4m4 4l4-4M4 21h16" />
        </svg>
      </span>
      <span className="font-mono text-sm font-bold tracking-tight text-slate-100">
        Export<span className="text-emerald-400">Vault</span>
      </span>
    </span>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);

  // Navigating on a phone should dismiss the drawer, otherwise it covers the
  // page the user just asked for.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer and returns focus to the control that opened it.
  useEffect(() => {
    if (!navOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNavOpen(false);
        toggleButtonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  // Move focus into the drawer when it opens so keyboard users are not left
  // behind the overlay.
  useEffect(() => {
    if (navOpen) closeButtonRef.current?.focus();
  }, [navOpen]);

  return (
    <div className="grid-backdrop flex min-h-screen w-full">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-emerald-500 px-4 py-2 font-semibold text-vault-950 focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>

      {/* Backdrop, mobile only. Rendered only while open so it never swallows
          clicks on desktop. */}
      {navOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      {/*
        ONE sidebar element for every breakpoint: an off-canvas drawer below
        `lg`, a static column at `lg` and above. Rendering separate mobile and
        desktop navs would duplicate every link in the accessibility tree.
      */}
      <aside
        id="primary-navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 transform flex-col border-r border-vault-700/70 bg-vault-950/95 backdrop-blur transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:bg-vault-950/60 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-4">
          <NavLink to="/dashboard" className="rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400">
            <Wordmark />
          </NavLink>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setNavOpen(false)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-vault-800 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 lg:hidden"
            aria-label="Close navigation"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
          <p className="px-3 pb-2 text-[10px] font-semibold tracking-widest text-slate-600 uppercase">
            Exports
          </p>
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400/60 ${
                      isActive
                        ? 'bg-vault-800 font-medium text-slate-100 ring-1 ring-inset ring-vault-700'
                        : 'text-slate-400 hover:bg-vault-850 hover:text-slate-200'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <svg
                        className={`h-4 w-4 shrink-0 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        aria-hidden="true"
                      >
                        {item.icon}
                      </svg>
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="shrink-0 border-t border-vault-700/70 p-3">
          <div className="min-w-0 px-2 pb-2">
            <div className="truncate text-xs font-medium text-slate-200">{user?.name}</div>
            <div className="truncate font-mono text-[11px] text-slate-500">{user?.email}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              logout();
              navigate('/login', { replace: true });
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-slate-400 transition-colors hover:bg-vault-800 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M18 15l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {/* min-w-0 lets wide children (the history table) scroll instead of
          forcing the whole page horizontal. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-vault-700/70 bg-vault-950/85 px-4 backdrop-blur lg:hidden">
          <button
            ref={toggleButtonRef}
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            aria-controls="primary-navigation"
            className="rounded-md p-1.5 text-slate-300 hover:bg-vault-800 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
            </svg>
          </button>
          <Wordmark />
        </header>

        <main id="main-content" className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
