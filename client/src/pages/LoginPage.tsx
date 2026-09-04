import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';
import { Button, ErrorState, Spinner } from '../components/ui';

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError({ message: 'Enter both your email address and password.' });
      return;
    }

    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      // The real reason from the API is shown; never a generic "try again".
      console.error('Login failed', err);
      setError(
        err instanceof ApiError
          ? { message: err.message, requestId: err.requestId }
          : { message: (err as Error).message },
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Access the export control plane."
      footer={
        <>
          No account?{' '}
          <Link to="/register" className="font-medium text-emerald-400 hover:text-emerald-300">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? <ErrorState title="Sign in failed" message={error.message} requestId={error.requestId} /> : null}

        <TextField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder="you@example.com"
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder="••••••••••"
          suppressAutofill
        />

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="grid-backdrop flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/15 ring-1 ring-emerald-400/30">
            <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v13m0 0l-4-4m4 4l4-4M4 21h16" />
            </svg>
          </span>
          <span className="font-mono text-base font-bold tracking-tight text-slate-100">
            Export<span className="text-emerald-400">Vault</span>
          </span>
        </div>

        <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-slate-400">{subtitle}</p>

        {children}

        <p className="mt-6 text-center text-sm text-slate-400">{footer}</p>
      </div>
    </div>
  );
}

export function TextField({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  suppressAutofill,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  /**
   * Keeps the browser from pre-filling a saved credential on page load, so the
   * field is empty until the user puts something in it.
   */
  suppressAutofill?: boolean;
}) {
  // Chrome fills a saved password into a sign-in form as the page loads, and
  // deliberately ignores autocomplete="off" on password inputs — so that is not
  // a fix. It does skip inputs that are read-only, which is what this guard
  // uses: the field is read-only across the load window, so the fill passes it
  // by and the box the user arrives at is empty.
  //
  // Chosen over autocomplete="new-password", which also suppresses the fill but
  // tells the browser this is a signup field — that triggers "suggest a strong
  // password" on a sign-in form and breaks the offer to save or update the
  // credential afterwards. The guard keeps autocomplete honest.
  const [autofillGuarded, setAutofillGuarded] = useState(suppressAutofill === true);

  // The guard covers the load window and nothing more. Left on permanently it
  // would also block the things that *should* be able to write to the field —
  // 1Password and friends, which set the value without the user ever focusing
  // the input, and test automation. Whichever comes first wins: the user
  // reaching for the field, or the fill window closing.
  useEffect(() => {
    if (!autofillGuarded) return;
    const timer = setTimeout(() => setAutofillGuarded(false), 600);
    return () => clearTimeout(timer);
  }, [autofillGuarded]);

  // Pointer-down lands before focus for mouse and touch, so the input is
  // already editable by the time focus arrives and assistive tech never
  // announces it as read-only.
  const releaseGuard = autofillGuarded ? () => setAutofillGuarded(false) : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-300">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        readOnly={autofillGuarded}
        onPointerDown={releaseGuard}
        onFocus={releaseGuard}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-vault-700 bg-vault-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40 focus:outline-none"
      />
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}
