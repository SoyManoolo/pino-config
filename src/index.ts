import { pino } from 'pino'
import cron from 'node-cron'
import { IDbLogHandler } from './types'
export * from './types'

export async function createLogger(handler: IDbLogHandler) {

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

  // Configuración e implementación de debug, info, warn y error
  const dbLogger = {
    debug: (message: string, meta?: object) => {
      if (handler.environment === 'development') {
        (logger.debug as any)(message, meta);
        handler.saveLog('debug', message, meta);
      }
    },
    info: (message: string, meta?: object) => {
      (logger.info as any)(message, meta);
      handler.saveLog('info', message, meta);
    },
    warn: (message: string, meta?: object) => {
      (logger.warn as any)(message, meta);
      handler.saveLog('warn', message, meta);
    },
    error: (message: string, meta?: object) => {
      (logger.error as any)(message, meta);
      handler.saveLog('error', message, meta);
    },
  };

  // Si el entorno de desarrollo no es de testing hacer que se ejecute el cron para el borrado de los logs a las 00:00 de cada día
  if (handler.environment !== 'test') {
    cron.schedule('0 0 * * *', async () => {
      try {
        const deletedLogs = await handler.cleanUpLogs();
        dbLogger.info(`[CRON] Logs cleanup executed at 00:00. Deleted ${deletedLogs} logs.`)
      } catch (error) {
        dbLogger.error('[CRON] Error in cron job deleting old logs:', { error });
      }
    });
    dbLogger.info(`Cron job scheduled for log cleanup`);
  } else {
    dbLogger.info('Cron job not scheduled in test environment.');
  }

  return dbLogger
}
