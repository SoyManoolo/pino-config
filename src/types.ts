export interface IDbLogHandler {
  environment: string;
  saveLog(level: string, message: string, meta?: object): Promise<void>;
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
  debug(message: string, meta?: object): Promise<void>;
  info(message: string, meta?: object): Promise<void>;
  warn(message: string, meta?: object): Promise<void>;
  error(message: string, meta?: object): Promise<void>;
  close(): Promise<void>;
}
