import { pino } from 'pino'
import cron from 'node-cron'
import { IDbLogHandler, Logger, LoggerOptions, LogLevel } from './types'
export * from './types'

interface CleanupOwner {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void>;
  reportPersistenceError(error: unknown): Promise<void>;
}

interface CleanupRegistration {
  task: ReturnType<typeof cron.schedule>;
  owners: Set<CleanupOwner>;
}

const cleanupRegistrations = new WeakMap<IDbLogHandler, CleanupRegistration>()

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
      log.call(logger, message);
    } else {
      log.call(logger, meta, message);
    }
  };

  const reportPersistenceError = async (error: unknown): Promise<void> => {
    try {
      await options.onPersistenceError?.(error);
    } catch (callbackError) {
      logToConsole('error', '[LOGGER] Persistence error callback failed.', {
        error: callbackError,
      });
    }
  };

  let pendingLogWrites = Promise.resolve();
  let isClosed = false;
  const enqueueLog = (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    pendingLogWrites = pendingLogWrites
      .then(() => handler.saveLog(level, message, meta))
      .catch(async (error: unknown) => {
        await reportPersistenceError(error);
        logToConsole('error', '[LOGGER] Failed to save log to database.', {
          error,
          level,
          message,
        });
      });

    return pendingLogWrites;
  };

  let cleanupRegistration: CleanupRegistration | undefined;
  const cleanupOwner: CleanupOwner = {
    log: enqueueLog,
    reportPersistenceError,
  };
  const releaseCleanup = (): void => {
    if (!cleanupRegistration) {
      return;
    }

    cleanupRegistration.owners.delete(cleanupOwner);
    if (cleanupRegistration.owners.size === 0) {
      cleanupRegistration.task.stop();
      cleanupRegistrations.delete(handler);
    }

    cleanupRegistration = undefined;
  };

  // Configuración e implementación de debug, info, warn y error
  const dbLogger: Logger = {
    debug: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (isClosed) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      if (handler.environment === 'development') {
        logToConsole('debug', message, meta);
        return enqueueLog('debug', message, meta);
      }

      return Promise.resolve();
    },
    info: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (isClosed) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('info', message, meta);
      return enqueueLog('info', message, meta);
    },
    warn: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (isClosed) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('warn', message, meta);
      return enqueueLog('warn', message, meta);
    },
    error: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (isClosed) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('error', message, meta);
      return enqueueLog('error', message, meta);
    },
    close: async (): Promise<void> => {
      isClosed = true;
      releaseCleanup();
      await pendingLogWrites;
    },
  };

  if (options.cleanup?.enabled) {
    const schedule = options.cleanup.schedule ?? '0 0 * * *';
    const cronOptions = options.cleanup.timezone
      ? { timezone: options.cleanup.timezone }
      : undefined;

    const existingRegistration = cleanupRegistrations.get(handler);
    if (existingRegistration) {
      cleanupRegistration = existingRegistration;
      existingRegistration.owners.add(cleanupOwner);
    } else {
      const registration = {
        task: undefined as unknown as ReturnType<typeof cron.schedule>,
        owners: new Set<CleanupOwner>([cleanupOwner]),
      };
      registration.task = cron.schedule(schedule, async () => {
        const owner = registration.owners.values().next().value as CleanupOwner | undefined;
        if (!owner) {
          return;
        }

        try {
          const deletedLogs = await handler.cleanUpLogs();
          await owner.log('info', `[CRON] Logs cleanup executed. Deleted ${deletedLogs} logs.`);
        } catch (error) {
          await owner.reportPersistenceError(error);
          await owner.log('error', '[CRON] Error in cron job deleting old logs:', { error });
        }
      }, cronOptions);
      cleanupRegistrations.set(handler, registration);
      cleanupRegistration = registration;
      dbLogger.info(`Cron job scheduled for log cleanup: ${schedule}`);
    }
  }

  return dbLogger
}
