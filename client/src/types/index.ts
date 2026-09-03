export type ExportStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'RESUMING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt?: string;
}

export interface Verification {
  expectedRows: number;
  actualRows: number;
  uniqueRows: number;
  duplicates: number;
  minId: number | string | null;
  maxId: number | string | null;
  outOfSnapshot: number;
  headerValid: boolean;
  fileBytes: number | string | null;
  sha256: string | null;
  status: 'PASSED' | 'FAILED';
  failureReason: string | null;
  verifiedAt?: string;
}

export interface ExportFailure {
  id: string;
  errorType: string;
  errorMessage: string;
  createdAt: string;
}

export interface ExportJob {
  id: string;
  status: ExportStatus;
  progress: { exportedRows: number; targetRows: number; percentage: number };
  lastExportedId: number | string | null;
  snapshotMaxId: number | string;
  requestedRowLimit: number;
  exportedRowCount: number;
  batchSize: number;
  fileKey: string | null;
  fileUrl: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  verification?: Verification | null;
}

export interface ExportJobDetail extends ExportJob {
  checkpointCount: number;
  verification: Verification | null;
  failures: ExportFailure[];
}

export interface ExportStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  interrupted: number;
  cancelled: number;
  totalRowsExported: number;
  byStatus: Record<string, number>;
  latest: ExportJob | null;
}

export interface DownloadInfo {
  url: string;
  filename: string;
  expiresInSeconds: number;
  fileBytes: number | string | null;
  sha256: string | null;
}
