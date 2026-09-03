import IORedis, { type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger, LogEvent } from '../utils/logger';

export const redisOptions: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  ...(env.REDIS_TLS ? { tls: {} } : {}),
  // BullMQ requires this to be null so blocking commands are not aborted.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

let sharedConnection: IORedis | null = null;

/** Lazily created shared ioredis connection used by the BullMQ queue. */
export function getRedisConnection(): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(redisOptions);
    sharedConnection.on('error', (error) => {
      // Never swallow: a broken queue connection means exports stop running.
      logger.error(
        { event: LogEvent.DEPENDENCY_FAILED, dependency: 'redis', err: error },
        'Redis connection error',
      );
    });
  }
  return sharedConnection;
}

/** Fails startup loudly if Redis is unreachable. */
export async function assertRedisConnection(): Promise<void> {
  const connection = getRedisConnection();
  try {
    const pong = await connection.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }
    logger.info({ event: LogEvent.DEPENDENCY_OK, dependency: 'redis' }, 'Redis connection verified');
  } catch (error) {
    logger.error(
      { event: LogEvent.DEPENDENCY_FAILED, dependency: 'redis', err: error },
      'Redis connection failed',
    );
    throw error;
  }
}

export async function closeRedisConnection(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = null;
  }
}
