-- CreateEnum
CREATE TYPE "export_status" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'INTERRUPTED', 'RESUMING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "records" (
    "id" BIGSERIAL NOT NULL,
    "external_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "category" VARCHAR(100),
    "amount" DECIMAL(12,2),
    "status" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "export_status" NOT NULL,
    "snapshot_max_id" BIGINT NOT NULL,
    "requested_row_limit" INTEGER NOT NULL DEFAULT 50000,
    "last_exported_id" BIGINT,
    "exported_row_count" INTEGER NOT NULL DEFAULT 0,
    "batch_size" INTEGER NOT NULL DEFAULT 1000,
    "file_key" TEXT,
    "file_url" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_checkpoints" (
    "id" UUID NOT NULL,
    "export_job_id" UUID NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "last_record_id" BIGINT NOT NULL,
    "rows_written" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_failures" (
    "id" UUID NOT NULL,
    "export_job_id" UUID,
    "error_type" VARCHAR(255) NOT NULL,
    "error_message" TEXT NOT NULL,
    "stack_trace" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_verifications" (
    "id" UUID NOT NULL,
    "export_job_id" UUID NOT NULL,
    "expected_rows" INTEGER NOT NULL,
    "actual_rows" INTEGER NOT NULL,
    "unique_rows" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "min_id" BIGINT,
    "max_id" BIGINT,
    "out_of_snapshot" INTEGER NOT NULL DEFAULT 0,
    "header_valid" BOOLEAN NOT NULL,
    "file_bytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "passed" BOOLEAN NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "records_external_id_idx" ON "records"("external_id");

-- CreateIndex
CREATE INDEX "records_id_idx" ON "records"("id");

-- CreateIndex
CREATE INDEX "records_created_at_idx" ON "records"("created_at");

-- CreateIndex
CREATE INDEX "export_jobs_user_id_idx" ON "export_jobs"("user_id");

-- CreateIndex
CREATE INDEX "export_jobs_status_idx" ON "export_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "export_checkpoints_job_batch_key" ON "export_checkpoints"("export_job_id", "batch_number");

-- CreateIndex
CREATE INDEX "export_failures_job_idx" ON "export_failures"("export_job_id");

-- CreateIndex
CREATE INDEX "export_verifications_job_idx" ON "export_verifications"("export_job_id");

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_checkpoints" ADD CONSTRAINT "export_checkpoints_export_job_id_fkey" FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_failures" ADD CONSTRAINT "export_failures_export_job_id_fkey" FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_verifications" ADD CONSTRAINT "export_verifications_export_job_id_fkey" FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
