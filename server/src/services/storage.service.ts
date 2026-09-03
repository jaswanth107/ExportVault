import { Readable, PassThrough } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger, LogEvent } from '../utils/logger';
import { AppError } from '../utils/errors';

/**
 * S3-compatible object storage. Local dev uses MinIO, production uses
 * Cloudflare R2 — identical API. Export CSVs are never permanently kept on the
 * backend's local disk, so they survive restarts and redeploys.
 */
export const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export const BUCKET = env.S3_BUCKET;

/**
 * A second client used ONLY to sign download URLs.
 *
 * The API talks to object storage over an internal address (e.g. `minio:9000`
 * inside the compose network) that a browser cannot resolve. A presigned URL is
 * bound to the host it was signed for, so it must be signed against the address
 * the *client* will actually request. With R2 or S3 the two are identical and
 * this collapses to the same configuration.
 */
const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;

export const s3Signer =
  publicEndpoint === env.S3_ENDPOINT
    ? s3
    : new S3Client({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      });

/** Object key for one batch chunk. Deterministic, so re-writing is idempotent. */
export function chunkKey(exportJobId: string, batchNumber: number): string {
  return `exports/${exportJobId}/chunks/${String(batchNumber).padStart(8, '0')}.csv`;
}

/** Object key for the assembled, downloadable CSV. */
export function finalKey(exportJobId: string): string {
  return `exports/${exportJobId}/export-${exportJobId}.csv`;
}

/**
 * Validates storage configuration before the process accepts export jobs, and
 * creates the bucket when the provider allows it (MinIO local dev).
 */
export async function assertStorageReady(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    logger.info(
      { event: LogEvent.DEPENDENCY_OK, dependency: 's3', bucket: BUCKET },
      'Object storage bucket verified',
    );
    return;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status !== 404 && status !== 403) {
      logger.error(
        { event: LogEvent.DEPENDENCY_FAILED, dependency: 's3', bucket: BUCKET, err: error },
        'Object storage is not reachable',
      );
      throw error;
    }
    logger.warn(
      { dependency: 's3', bucket: BUCKET, status },
      'Bucket missing — attempting to create it',
    );
  }

  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    logger.info(
      { event: LogEvent.DEPENDENCY_OK, dependency: 's3', bucket: BUCKET },
      'Object storage bucket created',
    );
  } catch (error) {
    logger.error(
      { event: LogEvent.DEPENDENCY_FAILED, dependency: 's3', bucket: BUCKET, err: error },
      'Could not create object storage bucket',
    );
    throw error;
  }
}

/**
 * Writes an object and then CONFIRMS it by reading back its size.
 * "No exception was thrown" is not accepted as proof the bytes landed.
 */
export async function putObjectVerified(key: string, body: Buffer): Promise<{ size: number }> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'text/csv; charset=utf-8',
    }),
  );

  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  const size = Number(head.ContentLength ?? -1);
  if (size !== body.byteLength) {
    throw new AppError(
      `Storage write verification failed for ${key}: expected ${body.byteLength} bytes, storage reports ${size}`,
      500,
      'STORAGE_WRITE_MISMATCH',
    );
  }
  return { size };
}

/** Streams an object's body. */
export async function getObjectStream(key: string): Promise<Readable> {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body) {
    throw new AppError(`Object ${key} has no body`, 500, 'STORAGE_EMPTY_BODY');
  }
  return result.Body as Readable;
}

export async function headObject(key: string): Promise<{ size: number }> {
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  return { size: Number(head.ContentLength ?? 0) };
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return false;
    // Any other failure is a real problem and must not be reported as "absent".
    logger.error({ err: error, key }, 'objectExists check failed');
    throw error;
  }
}

/**
 * Uploads a streamed body using multipart upload, so the assembled 50,000-row
 * CSV is never fully buffered in memory.
 */
export async function uploadStream(key: string, stream: Readable | PassThrough): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: stream,
      ContentType: 'text/csv; charset=utf-8',
    },
    queueSize: 1,
    partSize: 5 * 1024 * 1024,
  });
  await upload.done();
}

/** Presigned, time-limited download URL. */
export async function getSignedDownloadUrl(key: string, filename: string): Promise<string> {
  return getSignedUrl(
    s3Signer,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: 'text/csv; charset=utf-8',
    }),
    { expiresIn: env.S3_SIGNED_URL_TTL },
  );
}

/** Removes the per-batch chunk objects once they are no longer needed. */
export async function deleteChunks(exportJobId: string): Promise<number> {
  const prefix = `exports/${exportJobId}/chunks/`;
  let deleted = 0;
  let token: string | undefined;

  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key as string })).filter((o) => o.Key);
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }),
      );
      deleted += keys.length;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  return deleted;
}
