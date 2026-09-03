import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createExport } from '../api/exports';
import { ApiError } from '../api/client';
import { Button, ErrorState, Panel, PanelHeader, Spinner } from '../components/ui';

const ROW_LIMIT = 50000;

export function CreateExportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rowLimit, setRowLimit] = useState(ROW_LIMIT);

  const mutation = useMutation({
    mutationFn: () => createExport(rowLimit),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['exports'] });
      void queryClient.invalidateQueries({ queryKey: ['export-stats'] });
      navigate(`/exports/${result.export.id}`);
    },
    onError: (error) => {
      // Surfaced in the UI below; also logged so the browser console has it.
      console.error('Export creation failed', error);
    },
  });

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Create export</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          The export runs in a background worker. You can close this page; it will keep going.
        </p>
      </div>

      {/* Form and explainer sit side by side once there is room for both. */}
      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
        <Panel>
          <PanelHeader title="Export parameters" />
          <div className="space-y-5 px-5 py-5">
            <div>
              <label htmlFor="rowLimit" className="mb-1.5 block text-xs font-medium text-slate-300">
                Row limit
              </label>
              <input
                id="rowLimit"
                type="number"
                min={1}
                max={ROW_LIMIT}
                value={rowLimit}
                onChange={(e) => setRowLimit(Number(e.target.value))}
                className="w-full rounded-lg border border-vault-700 bg-vault-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Fixed at {ROW_LIMIT.toLocaleString()} for this assignment; the API rejects anything higher.
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3.5">
              <h3 className="text-xs font-semibold tracking-wide text-amber-300 uppercase">
                Snapshot consistency
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-amber-100/80">
                Records inserted after the export snapshot begins will not appear in this export. They
                will appear in future exports.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-amber-200/60">
                When the job is created the system captures <code className="font-mono">MAX(id)</code> from
                the records table and stores it as <code className="font-mono">snapshot_max_id</code>. Only
                rows with <code className="font-mono">id &lt;= snapshot_max_id</code> are exported. Anything
                inserted afterwards gets a higher id, so it is outside this export by construction — which
                is what keeps pagination stable while writes continue.
              </p>
            </div>

            {mutation.isError ? (
              <ErrorState
                title="Could not create the export"
                message={(mutation.error as Error).message}
                requestId={mutation.error instanceof ApiError ? mutation.error.requestId : undefined}
                onRetry={() => mutation.mutate()}
              />
            ) : null}

            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="w-full"
            >
              {mutation.isPending ? <Spinner /> : null}
              {mutation.isPending ? 'Capturing snapshot…' : 'Start Export'}
            </Button>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="What happens next" />
          <ol className="space-y-3 px-5 py-5 text-sm text-slate-400">
            {[
              'The API captures MAX(id) as an immutable snapshot boundary and persists the job.',
              'A BullMQ job is queued; a separate worker process picks it up.',
              'Rows are read in keyset-paginated batches (id > cursor AND id <= snapshot), never with OFFSET.',
              'Each batch is written to object storage, confirmed, then checkpointed in one transaction.',
              'Chunks are streamed into one CSV, which is re-read and verified before COMPLETED is set.',
            ].map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-vault-800 font-mono text-[11px] text-emerald-400">
                  {index + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
