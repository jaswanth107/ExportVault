import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { corsAllowlist, isProduction } from './config/env';
import { logger } from './utils/logger';
import { requestId } from './middleware/requestId.middleware';
import { generalLimiter } from './middleware/rateLimit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { apiRouter } from './routes';
import { health, readiness } from './controllers/health.controller';

// BigInt is not JSON-serialisable by default; ids are emitted as strings if any
// value ever escapes an explicit serializer.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser clients (curl, tests, server-to-server) send no Origin.
        if (!origin) return callback(null, true);
        if (corsAllowlist.includes(origin)) return callback(null, true);
        logger.warn({ origin, allowlist: corsAllowlist }, 'CORS origin rejected');
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { requestId: string }).requestId,
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return isProduction ? 'debug' : 'info';
      },
    }),
  );

  app.use(generalLimiter);

  app.get('/health', health);
  app.get('/health/ready', readiness);
  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
