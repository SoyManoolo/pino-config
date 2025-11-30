export interface IDbLogHandler {
  environment: string;
  saveLog(level: string, message: string, meta?: object): Promise<void>;
  cleanUpLogs(): Promise<number>;
  initialize?(): Promise<void>;
}
