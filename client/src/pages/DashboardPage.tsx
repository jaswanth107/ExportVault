import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchStats } from '../api/exports';
import { ApiError } from '../api/client';
import { Button, EmptyState, ErrorState, Panel, PanelHeader, ProgressBar, SkeletonBlock, Stat, StatusBadge } from '../components/ui';
import { formatDateTime, formatNumber, shortId } from '../utils/format';

const LIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'PENDING']);

export function DashboardPage() {
  const query = useQuery({
    queryKey: ['export-stats'],
    queryFn: fetchStats,
    // Poll while anything is in flight so the dashboard tracks live progress.
    refetchInterval: (q) => {
      const latest = q.state.data?.stats.latest;
      return latest && LIVE_STATUSES.has(latest.status) ? 1000 : false;
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-100">Export control</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Large CSV exports with a stable snapshot boundary, checkpointed batches and mandatory
            verification.
          </p>
        </div>
        <Link to="/exports/new" className="shrink-0">
          <Button className="w-full sm:w-auto">Create 50,000 Row Export</Button>
        </Link>
      </div>

      {query.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-[86px]" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title="Could not load your dashboard"
          message={(query.error as Error).message}
          requestId={query.error instanceof ApiError ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total export jobs" value={formatNumber(query.data.stats.total)} />
            <Stat
              label="Completed"
              value={formatNumber(query.data.stats.completed)}
              tone={query.data.stats.completed > 0 ? 'good' : 'default'}
              hint={`${formatNumber(query.data.stats.totalRowsExported)} rows exported`}
            />
            <Stat
              label="Failed"
              value={formatNumber(query.data.stats.failed)}
              tone={query.data.stats.failed > 0 ? 'bad' : 'default'}
              hint={query.data.stats.interrupted > 0 ? `${query.data.stats.interrupted} interrupted` : undefined}
            />
            <Stat
              label="Running"
              value={formatNumber(query.data.stats.running)}
              tone={query.data.stats.running > 0 ? 'warn' : 'default'}
            />
          </div>

          <Panel>
            <PanelHeader
              title="Latest export"
              subtitle="Most recently created job"
              action={
                <Link to="/exports">
                  <Button variant="ghost" className="py-1.5 text-xs">
                    View all
                  </Button>
                </Link>
              }
            />
            {query.data.stats.latest ? (
              <div className="space-y-5 px-5 py-5">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={query.data.stats.latest.status} />
                  <Link
                    to={`/exports/${query.data.stats.latest.id}`}
                    className="font-mono text-xs text-slate-400 hover:text-emerald-400"
                  >
                    {shortId(query.data.stats.latest.id)}…
                  </Link>
                  <span className="text-xs text-slate-500 sm:ml-auto">
                    created {formatDateTime(query.data.stats.latest.createdAt)}
                  </span>
                </div>

                <ProgressBar
                  value={query.data.stats.latest.progress.exportedRows}
                  total={query.data.stats.latest.progress.targetRows}
                  status={query.data.stats.latest.status}
                />

                {query.data.stats.latest.errorMessage ? (
                  <ErrorState
                    title={`Export ${query.data.stats.latest.status.toLowerCase()}`}
                    message={query.data.stats.latest.errorMessage}
                  />
                ) : null}

                <Link to={`/exports/${query.data.stats.latest.id}`}>
                  <Button variant="secondary" className="py-1.5 text-xs">
                    Open export details
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="px-5 py-5">
                <EmptyState
                  title="No exports yet."
                  message="Create your first 50,000-row export to see progress, checkpoints and verification here."
                  action={
                    <Link to="/exports/new">
                      <Button>Create 50,000 Row Export</Button>
                    </Link>
                  }
                />
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
