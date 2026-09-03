import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';
import { Button, ErrorState, Spinner } from '../components/ui';
import { AuthShell, TextField } from './LoginPage';

interface Rule {
  label: string;
  test: (value: string) => boolean;
}

const PASSWORD_RULES: Rule[] = [
  { label: 'At least 10 characters', test: (v) => v.length >= 10 },
  { label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { label: 'A digit', test: (v) => /[0-9]/.test(v) },
];

export function RegisterPage() {
  const { register, status } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string; details?: unknown } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  const unmetRules = PASSWORD_RULES.filter((rule) => !rule.test(password));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (name.trim().length < 2) {
      setError({ message: 'Your name must be at least 2 characters.' });
      return;
    }
    if (unmetRules.length > 0) {
      setError({ message: `Password requirement not met: ${unmetRules[0].label.toLowerCase()}.` });
      return;
    }

    setSubmitting(true);
    try {
      await register(name.trim(), email.trim(), password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      console.error('Registration failed', err);
      setError(
        err instanceof ApiError
          ? { message: err.message, requestId: err.requestId, details: err.details }
          : { message: (err as Error).message },
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create account"
      subtitle="Exports are scoped to your account only."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-medium text-emerald-400 hover:text-emerald-300">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? (
          <ErrorState title="Registration failed" message={error.message} requestId={error.requestId} />
        ) : null}

        <TextField id="name" label="Name" type="text" value={name} onChange={setName} autoComplete="name" placeholder="Ada Lovelace" />
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" />
        <TextField id="password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="••••••••••" />

        <ul className="space-y-1">
          {PASSWORD_RULES.map((rule) => {
            const met = rule.test(password);
            return (
              <li key={rule.label} className="flex items-center gap-2 text-[11px]">
                <span className={met ? 'text-emerald-400' : 'text-slate-600'}>{met ? '✓' : '○'}</span>
                <span className={met ? 'text-slate-400' : 'text-slate-500'}>{rule.label}</span>
              </li>
            );
          })}
        </ul>

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? <Spinner /> : null}
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
