import { pino } from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
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

interface PersistenceCallback {
  parent: PersistenceCallback | undefined;
  waitingForClose: boolean;
  readyToClose: Promise<void>;
  unblockClose(): void;
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

  let isClosing = false;
  let isClosed = false;
  const callbackContext = new AsyncLocalStorage<PersistenceCallback>();
  const pendingErrorCallbacks = new Map<PersistenceCallback, Promise<void>>();
  const reportPersistenceError = (error: unknown): Promise<void> => {
    const onPersistenceError = options.onPersistenceError;
    if (!onPersistenceError) {
      return Promise.resolve();
    }

    if (pendingErrorCallbacks.size >= maxPendingWrites) {
      logToConsole('error', '[LOGGER] Persistence error callback limit reached.', {
        error,
        limit: maxPendingWrites,
      });
      return Promise.resolve();
    }

    let unblockClose!: () => void;
    const readyToClose = new Promise<void>((resolve) => { unblockClose = resolve; });
    const callback: PersistenceCallback = {
      parent: callbackContext.getStore(),
      waitingForClose: false,
      readyToClose,
      unblockClose,
    };
    const completion = Promise.resolve().then(async () => {
      try {
        await callbackContext.run(callback, () => onPersistenceError.call(options, error));
      } catch (callbackError) {
        const message = '[LOGGER] Persistence error callback failed.';
        if (isClosed) {
          console.error(message, callbackError);
        } else {
          logToConsole('error', message, { error: callbackError });
        }
      } finally {
        pendingErrorCallbacks.delete(callback);
        callback.parent = undefined;
        callback.unblockClose();
      }
    });
    pendingErrorCallbacks.set(callback, completion);
    return completion;
  };

  let pendingLogWrites = Promise.resolve();
  let pendingWriteCount = 0;
  let transportClosePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const activeCallback = (): PersistenceCallback | undefined => {
    const callback = callbackContext.getStore();
    return callback && pendingErrorCallbacks.has(callback) ? callback : undefined;
  };
  const acceptsPublicLogs = () => !isClosed && (!isClosing || activeCallback() !== undefined);
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
    return write.then(async () => {
      if (failed) {
        logToConsole('error', '[LOGGER] Failed to save log to database.', {
          error: failure,
          level,
          message,
        });
        await reportPersistenceError(failure);
      }
    });
  };

  let cleanupRegistration: CleanupRegistration | undefined;
  const cleanupOwner: CleanupOwner = {
    log: (level, message, meta) => isClosing ? Promise.resolve() : enqueueLog(level, message, meta),
    reportPersistenceError: (error) => isClosing ? Promise.resolve() : reportPersistenceError(error),
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
      if (!acceptsPublicLogs()) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      if (handler.environment === 'development') {
        logToConsole('debug', message, meta);
        return enqueueLog('debug', message, meta);
      }

      return Promise.resolve();
    },
    info: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (!acceptsPublicLogs()) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('info', message, meta);
      return enqueueLog('info', message, meta);
    },
    warn: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (!acceptsPublicLogs()) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('warn', message, meta);
      return enqueueLog('warn', message, meta);
    },
    error: (message: string, meta?: Record<string, unknown>): Promise<void> => {
      if (!acceptsPublicLogs()) {
        return Promise.reject(new Error('Logger is closed.'));
      }

      logToConsole('error', message, meta);
      return enqueueLog('error', message, meta);
    },
    close: (): Promise<void> => {
      const callback = activeCallback();
      // A callback may await a log whose own error callback asks to close.
      for (let current = callback; current; current = current.parent) {
        current.waitingForClose = true;
        current.unblockClose();
      }

      if (!transportClosePromise) {
        isClosing = true;
        releaseCleanup();
        transportClosePromise = (async () => {
          try {
            while (true) {
              const queuedWrites = pendingLogWrites;
              await queuedWrites;
              await Promise.all([...pendingErrorCallbacks.keys()].map((report) => report.readyToClose));
              const callbacksReady = [...pendingErrorCallbacks.keys()].every((report) => report.waitingForClose);
              if (queuedWrites === pendingLogWrites && callbacksReady) {
                break;
              }
            }
          } finally {
            isClosed = true;
            const transportClosed = transportFinished();
            transport.end();
            await transportClosed;
          }
        })();
      }

      // Only callers outside error callbacks wait for callbacks that are themselves closing.
      return callback
        ? transportClosePromise
        : closePromise ??= transportClosePromise.finally(() => Promise.all(pendingErrorCallbacks.values()));
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
