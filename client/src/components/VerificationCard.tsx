import type { Verification } from '../types';
import { formatBytes, formatNumber } from '../utils/format';
import { Panel, PanelHeader } from './ui';

function Row({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-vault-800 py-2.5 last:border-0">
      <span className="shrink-0 text-xs text-slate-400">{label}</span>
      <span
        className={`font-mono text-sm font-semibold tabular-nums ${
          ok === undefined ? 'text-slate-200' : ok ? 'text-emerald-300' : 'text-red-300'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function VerificationCard({ verification }: { verification: Verification | null }) {
  if (!verification) {
    return (
      <Panel>
        <PanelHeader title="Verification" subtitle="Runs automatically once the CSV exists" />
        <div className="px-5 py-6 text-sm text-slate-400">
          No verification has run yet. An export is only marked COMPLETED after its generated CSV
          has been re-read and proved correct.
        </div>
      </Panel>
    );
  }

  const passed = verification.status === 'PASSED';

  return (
    <Panel className={passed ? 'ring-1 ring-emerald-500/20' : 'ring-1 ring-red-500/25'}>
      <PanelHeader
        title="Verification"
        subtitle="Recomputed by re-reading the stored CSV"
        action={
          <span
            data-testid="verification-status"
            data-status={verification.status}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] font-bold tracking-wider ring-1 ring-inset ${
              passed
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40'
                : 'bg-red-500/15 text-red-300 ring-red-400/40'
            }`}
          >
            {passed ? '✓' : '✕'} {verification.status}
          </span>
        }
      />
      <div className="px-5 py-2">
        <Row label="Expected Rows" value={formatNumber(verification.expectedRows)} />
        <Row
          label="Actual Rows"
          value={formatNumber(verification.actualRows)}
          ok={verification.actualRows === verification.expectedRows}
        />
        <Row
          label="Unique IDs"
          value={formatNumber(verification.uniqueRows)}
          ok={verification.uniqueRows === verification.expectedRows}
        />
        <Row label="Duplicates" value={formatNumber(verification.duplicates)} ok={verification.duplicates === 0} />
        <Row
          label="Rows beyond snapshot"
          value={formatNumber(verification.outOfSnapshot)}
          ok={verification.outOfSnapshot === 0}
        />
        <Row label="Header valid" value={verification.headerValid ? 'yes' : 'no'} ok={verification.headerValid} />
        <Row label="ID range" value={`${formatNumber(verification.minId)} → ${formatNumber(verification.maxId)}`} />
        <Row label="File size" value={formatBytes(verification.fileBytes)} />
        <Row
          label="SHA-256"
          value={verification.sha256 ? `${verification.sha256.slice(0, 16)}…` : '—'}
        />
      </div>
      {verification.failureReason ? (
        <div className="border-t border-red-500/25 bg-red-500/5 px-5 py-3">
          <p className="text-xs font-semibold text-red-300">Why it failed</p>
          <p className="mt-1 font-mono text-xs break-words text-red-300/90">
            {verification.failureReason}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
