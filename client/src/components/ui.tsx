import type { ReactNode } from 'react';
import type { ExportStatus } from '../types';

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-vault-700/70 bg-vault-900/70 backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function PanelHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-vault-700/70 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-slate-100 uppercase">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

const STATUS_STYLES: Record<ExportStatus, { bg: string; text: string; ring: string; dot: string; live?: boolean }> = {
  PENDING:     { bg: 'bg-slate-500/10',  text: 'text-slate-300',   ring: 'ring-slate-400/30',   dot: 'bg-slate-400' },
  QUEUED:      { bg: 'bg-sky-500/10',    text: 'text-sky-300',     ring: 'ring-sky-400/30',     dot: 'bg-sky-400' },
  RUNNING:     { bg: 'bg-cyan-500/10',   text: 'text-cyan-300',    ring: 'ring-cyan-400/40',    dot: 'bg-cyan-400', live: true },
  RESUMING:    { bg: 'bg-indigo-500/10', text: 'text-indigo-300',  ring: 'ring-indigo-400/40',  dot: 'bg-indigo-400', live: true },
  VERIFYING:   { bg: 'bg-violet-500/10', text: 'text-violet-300',  ring: 'ring-violet-400/40',  dot: 'bg-violet-400', live: true },
  INTERRUPTED: { bg: 'bg-amber-500/10',  text: 'text-amber-300',   ring: 'ring-amber-400/40',   dot: 'bg-amber-400' },
  COMPLETED:   { bg: 'bg-emerald-500/10',text: 'text-emerald-300', ring: 'ring-emerald-400/40', dot: 'bg-emerald-400' },
  FAILED:      { bg: 'bg-red-500/10',    text: 'text-red-300',     ring: 'ring-red-400/40',     dot: 'bg-red-400' },
  CANCELLED:   { bg: 'bg-slate-500/10',  text: 'text-slate-400',   ring: 'ring-slate-500/30',   dot: 'bg-slate-500' },
};

export function StatusBadge({ status }: { status: ExportStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wider ring-1 ring-inset ${style.bg} ${style.text} ${style.ring}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${style.live ? 'live-dot' : ''}`} />
      {status}
    </span>
  );
}

export function ProgressBar({
  value,
  total,
  status,
}: {
  value: number;
  total: number;
  status: ExportStatus;
}) {
  const percentage = total > 0 ? Math.min(100, Math.floor((value / total) * 100)) : 0;
  const tone =
    status === 'FAILED'
      ? 'bg-red-500'
      : status === 'INTERRUPTED'
        ? 'bg-amber-500'
        : status === 'COMPLETED'
          ? 'bg-emerald-500'
          : 'bg-cyan-500';

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between font-mono text-xs">
        <span className="text-slate-300" data-testid="progress-rows">
          {value.toLocaleString()} / {total.toLocaleString()} rows
        </span>
        <span className="text-slate-400" data-testid="progress-percentage">
          {percentage}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-vault-800 ring-1 ring-inset ring-vault-700">
        <div
          className={`h-full rounded-full transition-all duration-500 ${tone}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'good' | 'bad' | 'warn';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'bad'
        ? 'text-red-300'
        : tone === 'warn'
          ? 'text-amber-300'
          : 'text-slate-100';

  return (
    <div className="rounded-lg border border-vault-700/70 bg-vault-850/60 px-4 py-3">
      <div className="text-[11px] font-medium tracking-wider text-slate-500 uppercase">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function Field({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    // Stacked on narrow screens so a long value (a UUID) cannot squeeze the
    // label into a wrapped column.
    <div className="flex flex-col gap-0.5 border-b border-vault-800 py-2.5 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="shrink-0 text-xs text-slate-500">{label}</span>
      <span className={`text-xs break-all text-slate-200 sm:text-right ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  const variants = {
    primary:
      'bg-emerald-500 text-vault-950 hover:bg-emerald-400 focus-visible:outline-emerald-400 disabled:bg-emerald-500/40 disabled:text-vault-950/60',
    secondary:
      'bg-vault-700 text-slate-100 hover:bg-vault-600 focus-visible:outline-slate-400 disabled:opacity-50',
    danger:
      'bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/40 hover:bg-red-500/25 focus-visible:outline-red-400 disabled:opacity-50',
    ghost:
      'text-slate-300 hover:bg-vault-800 hover:text-slate-100 focus-visible:outline-slate-500 disabled:opacity-50',
  };

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function SkeletonBlock({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />;
}

/** Every failure the UI encounters is shown, with the reason and a retry path. */
export function ErrorState({
  title = 'Something failed',
  message,
  requestId,
  onRetry,
}: {
  title?: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      data-testid="error-state"
      className="rounded-xl border border-red-500/30 bg-red-500/5 px-5 py-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/20 text-xs font-bold text-red-300">
          !
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-red-200">{title}</h3>
          <p className="mt-1 text-sm break-words text-red-300/90">{message}</p>
          {requestId ? (
            <p className="mt-2 font-mono text-[11px] text-red-400/70">request id: {requestId}</p>
          ) : null}
          {onRetry ? (
            <Button variant="danger" className="mt-3 py-1.5 text-xs" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-vault-700 bg-vault-900/40 px-6 py-14 text-center"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-vault-800 text-slate-500">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75h16.5M3.75 14.25h16.5M5.25 4.5h13.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
        </svg>
      </div>
      <h3 className="mt-4 text-sm font-semibold text-slate-200">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-400">{message}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
