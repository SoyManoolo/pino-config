import { pino } from 'pino'
import { finished } from 'node:stream/promises'
import { Cron } from 'croner'
import { IDbLogHandler, Logger, LoggerOptions, LogLevel } from './types'
export * from './types'

interface CleanupOwner {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void>;
  reportPersistenceError(error: unknown): Promise<void>;
}

interface CleanupRegistration {
  task: Cron;
  owners: Set<CleanupOwner>;
  schedule: string;
  timezone: string | undefined;
}

const cleanupRegistrations = new WeakMap<IDbLogHandler, CleanupRegistration>()
const initializations = new WeakMap<IDbLogHandler, Promise<void>>()
const DEFAULT_MAX_PENDING_WRITES = 1000

export class PendingLogWritesLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Pending log write limit reached (${limit}).`)
    this.name = 'PendingLogWritesLimitError'
  }
}

export async function createLogger(
  handler: IDbLogHandler,
  options: LoggerOptions = {},
): Promise<Logger> {
  const maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES
  if (!Number.isSafeInteger(maxPendingWrites) || maxPendingWrites < 1) {
    throw new RangeError('maxPendingWrites must be a positive safe integer.')
  }

  const initialize = handler.initialize
  if (initialize) {
    let initialization = initializations.get(handler)
    if (!initialization) {
      initialization = Promise.resolve().then(() => initialize.call(handler))
      initializations.set(handler, initialization)
    }

    try {
      await initialization
    } catch (error) {
      if (initializations.get(handler) === initialization) {
        initializations.delete(handler)
      }
      throw error
    }
  }

  const cleanupSchedule = options.cleanup?.enabled
    ? options.cleanup.schedule ?? '0 0 * * *'
    : undefined;
  const cleanupTimezone = options.cleanup?.timezone || undefined;
  const existingRegistration = cleanupSchedule === undefined
    ? undefined
    : cleanupRegistrations.get(handler);
  if (existingRegistration &&
    (existingRegistration.schedule !== cleanupSchedule || existingRegistration.timezone !== cleanupTimezone)) {
    throw new Error('Conflicting cleanup configuration for shared handler: schedule and timezone must match the existing cleanup task.');
  }

  const transport = pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'yyyy-mm-dd HH:MM:ss.l',
    },
  });
  // ThreadStream is a writable stream at runtime, but its typings do not extend Node's stream types.
  const transportFinished = (): Promise<void> => finished(transport as unknown as NodeJS.WritableStream);
  const disposeFailedTransport = (): void => {
    void transportFinished().catch(() => undefined);
    transport.end();
  };
  let logger: ReturnType<typeof pino>;
  try {
    logger = pino({
      level: handler.environment === 'production' ? 'info' : 'debug',
    }, transport);
  } catch (error) {
    disposeFailedTransport();
    throw error;
  }

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
  const pendingReports = new Set<Promise<void>>();
  let pendingWriteCount = 0;
  let isClosed = false;
  let closePromise: Promise<void> | undefined;
  const enqueueLog = (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    if (pendingWriteCount >= maxPendingWrites) {
      return Promise.reject(new PendingLogWritesLimitError(maxPendingWrites));
    }

    pendingWriteCount++;
    let failed = false;
    let failure: unknown;
    const write = pendingLogWrites
      .then(() => handler.saveLog(level, message, meta))
      .catch((error: unknown) => {
        failed = true;
        failure = error;
      })
      .finally(() => {
        pendingWriteCount--;
      });

    pendingLogWrites = write;
    const completion = write.then(async () => {
      if (failed) {
        await reportPersistenceError(failure);
        logToConsole('error', '[LOGGER] Failed to save log to database.', {
          error: failure,
          level,
          message,
        });
      }
    });
    pendingReports.add(completion);
    void completion.then(
      () => pendingReports.delete(completion),
      () => pendingReports.delete(completion),
    );
    return completion;
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
    close: (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }

      releaseCleanup();
      closePromise = (async () => {
        try {
          while (true) {
            const queuedWrites = pendingLogWrites;
            await queuedWrites;
            await Promise.all([...pendingReports]);
            if (queuedWrites === pendingLogWrites && pendingReports.size === 0) {
              isClosed = true;
              break;
            }
          }
        } finally {
          const transportClosed = transportFinished();
          transport.end();
          await transportClosed;
        }
      })();
      return closePromise;
    },
  };

  try {
    if (cleanupSchedule !== undefined) {
      const cronOptions = cleanupTimezone ? { timezone: cleanupTimezone } : undefined;

      if (existingRegistration) {
        cleanupRegistration = existingRegistration;
        existingRegistration.owners.add(cleanupOwner);
      } else {
        const registration: CleanupRegistration = {
          task: undefined as unknown as Cron,
          owners: new Set<CleanupOwner>([cleanupOwner]),
          schedule: cleanupSchedule,
          timezone: cleanupTimezone,
        };
        registration.task = new Cron(cleanupSchedule, cronOptions, async () => {
          const owner = registration.owners.values().next().value as CleanupOwner | undefined;
          if (!owner) {
            return;
          }

          let deletedLogs: number;
          try {
            deletedLogs = await handler.cleanUpLogs();
          } catch (error) {
            await owner.reportPersistenceError(error);
            try {
              await owner.log('error', '[CRON] Error in cron job deleting old logs:', { error });
            } catch {
              // The cleanup error has already been reported; a full queue cannot record it again.
            }
            return;
          }

          try {
            await owner.log('info', `[CRON] Logs cleanup executed. Deleted ${deletedLogs} logs.`);
          } catch (logError) {
            await owner.reportPersistenceError(logError);
          }
        });
        cleanupRegistrations.set(handler, registration);
        cleanupRegistration = registration;
        dbLogger.info(`Cron job scheduled for log cleanup: ${cleanupSchedule}`);
      }
    }
  } catch (error) {
    releaseCleanup();
    disposeFailedTransport();
    throw error;
  }

  return dbLogger
}
