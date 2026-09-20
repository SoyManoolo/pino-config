export type Environment = 'development' | 'production' | 'test';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IDbLogHandler {
  environment: Environment;
  saveLog(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void>;
  cleanUpLogs(): Promise<number>;
  initialize?(): Promise<void>;
}

export interface LoggerOptions {
  cleanup?: {
    enabled?: boolean;
    schedule?: string;
    timezone?: string;
  };
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): Promise<void>;
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
