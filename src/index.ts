import { pino } from 'pino'
import cron from 'node-cron'
import { IDbLogHandler, Logger, LoggerOptions, LogLevel } from './types'
export * from './types'

export async function createLogger(
  handler: IDbLogHandler,
  options: LoggerOptions = {},
): Promise<Logger> {

  // Si la función de inicialización está definida, llamarla para que se ejecute
  if (handler.initialize) {
    await handler.initialize();
  }

  const logger = pino({
    level: handler.environment === 'production' ? 'info' : 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'yyyy-mm-dd HH:MM:ss.SSS',
      },
    },
  });

  const logToConsole = (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    const log = logger[level] as any;
    if (meta === undefined) {
      log(message);
    } else {
      log(meta, message);
    }
  };

  let pendingLogWrites = Promise.resolve();
  const enqueueLog = (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    pendingLogWrites = pendingLogWrites
      .then(() => handler.saveLog(level, message, meta))
      .catch((error: unknown) => {
        logToConsole('error', '[LOGGER] Failed to save log to database.', {
          error,
          level,
          message,
        });
      });

    return pendingLogWrites;
  };

  let cleanupTask: ReturnType<typeof cron.schedule> | undefined;

  // Configuración e implementación de debug, info, warn y error
  const dbLogger: Logger = {
    debug: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (handler.environment === 'development') {
        logToConsole('debug', message, meta);
        return enqueueLog('debug', message, meta);
      }

      return Promise.resolve();
    },
    info: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      logToConsole('info', message, meta);
      return enqueueLog('info', message, meta);
    },
    warn: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      logToConsole('warn', message, meta);
      return enqueueLog('warn', message, meta);
    },
    error: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      logToConsole('error', message, meta);
      return enqueueLog('error', message, meta);
    },
    close: async (): Promise<void> => {
      cleanupTask?.stop();
      await pendingLogWrites;
    },
  };

  if (options.cleanup?.enabled) {
    const schedule = options.cleanup.schedule ?? '0 0 * * *';
    const cronOptions = options.cleanup.timezone
      ? { timezone: options.cleanup.timezone }
      : undefined;

    cleanupTask = cron.schedule(schedule, async () => {
      try {
        const deletedLogs = await handler.cleanUpLogs();
        dbLogger.info(`[CRON] Logs cleanup executed. Deleted ${deletedLogs} logs.`)
      } catch (error) {
        dbLogger.error('[CRON] Error in cron job deleting old logs:', { error });
      }
    }, cronOptions);
    dbLogger.info(`Cron job scheduled for log cleanup: ${schedule}`);
  }

  return dbLogger
}
