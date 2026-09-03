import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listExports } from '../api/exports';
import { ApiError } from '../api/client';
import { Button, EmptyState, ErrorState, Panel, SkeletonBlock, StatusBadge } from '../components/ui';
import { formatDateTime, formatNumber, shortId } from '../utils/format';

const LIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'PENDING']);

/**
 * Narrow screens drop the columns that are recoverable from the detail page,
 * so the essentials (id, status, rows exported, action) stay readable without
 * the table sliding sideways.
 */
const COLUMNS = [
  { label: 'Export ID', className: '' },
  { label: 'Status', className: '' },
  { label: 'Requested', className: 'hidden sm:table-cell' },
  { label: 'Exported', className: '' },
  { label: 'Created', className: 'hidden lg:table-cell' },
  { label: 'Completed', className: 'hidden xl:table-cell' },
  { label: 'Verification', className: 'hidden md:table-cell' },
  { label: '', className: '' },
] as const;

export function ExportHistoryPage() {
  const query = useQuery({
    queryKey: ['exports'],
    queryFn: listExports,
    refetchInterval: (q) =>
      q.state.data?.exports.some((e) => LIVE_STATUSES.has(e.status)) ? 1500 : false,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-100">Export history</h1>
          <p className="mt-1 text-sm text-slate-400">Every export job created by your account.</p>
        </div>
        <Link to="/exports/new" className="shrink-0">
          <Button className="w-full sm:w-auto">Create 50,000 Row Export</Button>
        </Link>
      </div>

      {query.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-14" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title="Could not load your export history"
          message={(query.error as Error).message}
          requestId={query.error instanceof ApiError ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.exports.length === 0 ? (
        <EmptyState
          title="No exports yet."
          message="Create your first 50,000-row export."
          action={
            <Link to="/exports/new">
              <Button>Create 50,000 Row Export</Button>
            </Link>
          }
        />
      ) : (
        <Panel className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-vault-700/70 bg-vault-850/50">
                  {COLUMNS.map((column) => (
                    <th
                      key={column.label || 'actions'}
                      scope="col"
                      className={`px-4 py-2.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase ${column.className}`}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-vault-800">
                {query.data.exports.map((job) => (
                  <tr key={job.id} className="transition-colors hover:bg-vault-850/40" data-testid="export-row">
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{shortId(job.id)}…</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs tabular-nums text-slate-400 sm:table-cell">
                      {formatNumber(job.requestedRowLimit)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-slate-300">
                      {formatNumber(job.exportedRowCount)}
                    </td>
                    <td className="hidden px-4 py-3 text-xs whitespace-nowrap text-slate-500 lg:table-cell">
                      {formatDateTime(job.createdAt)}
                    </td>
                    <td className="hidden px-4 py-3 text-xs whitespace-nowrap text-slate-500 xl:table-cell">
                      {formatDateTime(job.completedAt)}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {job.verification ? (
                        <span
                          className={`font-mono text-[11px] font-semibold ${
                            job.verification.status === 'PASSED' ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {job.verification.status === 'PASSED' ? '✓ PASSED' : '✕ FAILED'}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/exports/${job.id}`}
                        className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
