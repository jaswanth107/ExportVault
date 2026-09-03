// Runs before any test module is imported, so config/env.ts sees these values.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
// Reliability tests kill workers on purpose; a short stall timeout lets the
// sweeper notice the dead worker within the test's lifetime.
process.env.EXPORT_STALL_TIMEOUT_SECONDS = '2';
