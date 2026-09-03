import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelExport, fetchDownload, fetchExport, resumeExport } from '../api/exports';
import { ApiError } from '../api/client';
import {
  Button,
  ErrorState,
  Field,
  Panel,
  PanelHeader,
  ProgressBar,
  SkeletonBlock,
  Spinner,
  StatusBadge,
} from '../components/ui';
import { VerificationCard } from '../components/VerificationCard';
import { formatBytes, formatDateTime, formatDuration, formatNumber } from '../utils/format';

const LIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'PENDING']);

export function ExportDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; filename: string; sha256: string | null; fileBytes: number | string | null } | null>(null);

  const query = useQuery({
    queryKey: ['export', id],
    queryFn: () => fetchExport(id),
    refetchInterval: (q) => (q.state.data && LIVE_STATUSES.has(q.state.data.status) ? 1000 : false),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['export', id] });
    void queryClient.invalidateQueries({ queryKey: ['export-stats'] });
    void queryClient.invalidateQueries({ queryKey: ['exports'] });
  };

  const resumeMutation = useMutation({
    mutationFn: () => resumeExport(id),
    onSuccess: invalidate,
    onError: (error) => {
      console.error('Resume failed', error);
      setActionError((error as Error).message);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelExport(id),
    onSuccess: invalidate,
    onError: (error) => {
      console.error('Cancel failed', error);
      setActionError((error as Error).message);
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () => fetchDownload(id),
    onSuccess: (result) => {
      setDownload(result.download);
      window.location.href = result.download.url;
    },
    onError: (error) => {
      console.error('Download failed', error);
      setActionError((error as Error).message);
    },
  });

  if (query.isPending) {
    return (
      <div className="space-y-4">
        <SkeletonBlock className="h-8 w-64" />
        <SkeletonBlock className="h-40" />
        <SkeletonBlock className="h-64" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Could not load this export"
        message={(query.error as Error).message}
        requestId={query.error instanceof ApiError ? query.error.requestId : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const job = query.data;
  const canResume = ['INTERRUPTED', 'FAILED', 'PENDING', 'QUEUED', 'RESUMING'].includes(job.status);
  const canCancel = ['PENDING', 'QUEUED', 'RUNNING', 'RESUMING', 'INTERRUPTED'].includes(job.status);
  const canDownload = job.status === 'COMPLETED' && job.verification?.status === 'PASSED';

  return (
    <div className="space-y-6">
      <div>
        <Link to="/exports" className="text-xs text-slate-500 hover:text-slate-300">
          ← Export history
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-base font-semibold text-slate-100" data-testid="export-id">
            {job.id}
          </h1>
          <StatusBadge status={job.status} />
        </div>
      </div>

      {actionError ? (
        <ErrorState title="Action failed" message={actionError} onRetry={() => setActionError(null)} />
      ) : null}

      {job.errorMessage ? (
        <ErrorState
          title={job.status === 'INTERRUPTED' ? 'Export interrupted' : 'Export failed'}
          message={job.errorMessage}
        />
      ) : null}

      <Panel>
        <PanelHeader
          title="Progress"
          subtitle={`Batch size ${formatNumber(job.batchSize)} · ${formatNumber(job.checkpointCount)} checkpoints persisted`}
        />
        <div className="space-y-5 px-5 py-5">
          <ProgressBar
            value={job.progress.exportedRows}
            total={job.progress.targetRows}
            status={job.status}
          />

          <div className="flex flex-wrap gap-2">
            {canDownload ? (
              <Button onClick={() => downloadMutation.mutate()} disabled={downloadMutation.isPending}>
                {downloadMutation.isPending ? <Spinner /> : null}
                Download CSV
              </Button>
            ) : null}
            {canResume ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setActionError(null);
                  resumeMutation.mutate();
                }}
                disabled={resumeMutation.isPending}
                data-testid="resume-button"
              >
                {resumeMutation.isPending ? <Spinner /> : null}
                Resume export
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                variant="danger"
                onClick={() => {
                  setActionError(null);
                  cancelMutation.mutate();
                }}
                disabled={cancelMutation.isPending}
              >
                {cancelMutation.isPending ? <Spinner /> : null}
                Cancel export
              </Button>
            ) : null}
          </div>

          {download ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
              <p className="text-xs font-semibold text-emerald-300">Download issued</p>
              <p className="mt-1 font-mono text-[11px] break-all text-emerald-200/70">
                {download.filename} · {formatBytes(download.fileBytes)} · sha256 {download.sha256?.slice(0, 24)}…
              </p>
              <a
                href={download.url}
                className="mt-2 inline-block font-mono text-[11px] text-emerald-400 underline hover:text-emerald-300"
              >
                Open signed URL again
              </a>
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Job details" />
          <div className="px-5 py-2">
            <Field label="Export ID" value={job.id} />
            <Field label="Status" value={job.status} />
            <Field label="Requested rows" value={formatNumber(job.requestedRowLimit)} />
            <Field label="Exported rows" value={formatNumber(job.exportedRowCount)} />
            <Field label="Snapshot max ID" value={formatNumber(job.snapshotMaxId)} />
            <Field label="Last exported ID" value={formatNumber(job.lastExportedId)} />
            <Field label="Checkpoints" value={formatNumber(job.checkpointCount)} />
            <Field label="Created" value={formatDateTime(job.createdAt)} />
            <Field label="Started" value={formatDateTime(job.startedAt)} />
            <Field label="Completed" value={formatDateTime(job.completedAt)} />
            <Field label="Failed at" value={formatDateTime(job.failedAt)} />
            <Field label="Duration" value={formatDuration(job.startedAt, job.completedAt)} />
          </div>
        </Panel>

        <VerificationCard verification={job.verification} />
      </div>

      <Panel>
        <PanelHeader
          title="Failure log"
          subtitle="Every failure is persisted, never swallowed"
        />
        {job.failures.length === 0 ? (
          <p className="px-5 py-5 text-sm text-slate-500">No failures recorded for this export.</p>
        ) : (
          <ul className="divide-y divide-vault-800">
            {job.failures.map((failure) => (
              <li key={failure.id} className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="rounded bg-red-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-red-300 ring-1 ring-inset ring-red-500/30">
                    {failure.errorType}
                  </span>
                  <span className="text-[11px] text-slate-500">{formatDateTime(failure.createdAt)}</span>
                </div>
                <p className="mt-1.5 font-mono text-xs break-words text-slate-400">
                  {failure.errorMessage}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
