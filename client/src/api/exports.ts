import { apiRequest } from './client';
import type { DownloadInfo, ExportJob, ExportJobDetail, ExportStats, Verification } from '../types';

export function createExport(rowLimit: number) {
  return apiRequest<{ success: true; export: ExportJob }>('/api/exports', {
    method: 'POST',
    body: { rowLimit },
  });
}

export function listExports() {
  return apiRequest<{ success: true; exports: ExportJob[] }>('/api/exports');
}

export function fetchStats() {
  return apiRequest<{ success: true; stats: ExportStats }>('/api/exports/stats');
}

export function fetchExport(id: string) {
  return apiRequest<{ success: true } & ExportJobDetail>(`/api/exports/${id}`);
}

export function resumeExport(id: string) {
  return apiRequest<{ success: true; export: ExportJob }>(`/api/exports/${id}/resume`, {
    method: 'POST',
  });
}

export function cancelExport(id: string) {
  return apiRequest<{ success: true; export: ExportJob }>(`/api/exports/${id}/cancel`, {
    method: 'POST',
  });
}

export function fetchDownload(id: string) {
  return apiRequest<{ success: true; download: DownloadInfo }>(`/api/exports/${id}/download`);
}

export function runVerification(id: string) {
  return apiRequest<{ success: true; recomputed: boolean; verification: Verification | null; message?: string }>(
    `/api/exports/${id}/verify`,
  );
}
