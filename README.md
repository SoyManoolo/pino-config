# pino-config

Custom Pino configuration for database logging with opt-in cleanup and environment-based log levels.

## Features

- 🎨 Pretty logging with colored output for development
- 💾 Database logging integration through custom handlers
- 🧹 Optional log cleanup with configurable cron jobs
- 🌍 Environment-based log level configuration
- 🔧 TypeScript support with full type definitions
- ⚡ Optional initialization hook for database setup

## Installation

```bash
npm install pino-config
```

## Usage

### Basic Setup

First, implement the `IDbLogHandler` interface to define how logs should be stored in your database:

```typescript
import { Environment, IDbLogHandler, LogLevel } from 'pino-config';

class MyDatabaseHandler implements IDbLogHandler {
  environment: Environment;

  constructor(env: Environment) {
    this.environment = env;
  }

  async initialize(): Promise<void> {
    // Optional: Setup database connection, create tables, etc.
    console.log('Database initialized');
  }

  async saveLog(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    // Save log to your database
    // Example: await db.logs.create({ level, message, meta, timestamp: new Date() });
  }

  async cleanUpLogs(): Promise<number> {
    // Clean up old logs (e.g., delete logs older than 30 days)
    // Return the number of deleted logs
    // Example: const result = await db.logs.deleteMany({ timestamp: { $lt: thirtyDaysAgo } });
    // return result.deletedCount;
    return 0;
  }
}
```

### Creating the Logger

```typescript
import { createLogger } from 'pino-config';

const environment: Environment =
  process.env.NODE_ENV === 'production' ||
  process.env.NODE_ENV === 'test' ||
  process.env.NODE_ENV === 'development'
    ? process.env.NODE_ENV
    : 'development';
const handler = new MyDatabaseHandler(environment);

async function main() {
  const logger = await createLogger(handler);

  // Await log calls when persistence must be complete before continuing.
  await logger.debug('Debug message', { userId: 123 });
  await logger.info('User logged in', { username: 'john' });
  await logger.warn('Deprecated API called', { endpoint: '/old-api' });
  await logger.error('Database connection failed', { error: 'Connection timeout' });
}

void main();
```

## Migrating to 2.0.0

Version 2 narrows the `environment` type to `Environment` (`'development'`,
`'production'`, or `'test'`). Normalize `NODE_ENV` before constructing your
handler:

```typescript
import { Environment } from 'pino-config';

const environment: Environment =
  process.env.NODE_ENV === 'production' ||
  process.env.NODE_ENV === 'test' ||
  process.env.NODE_ENV === 'development'
    ? process.env.NODE_ENV
    : 'development';
```

`createLogger` and every logger method return promises. Await them when
initialization or persistence must finish before continuing, and call
`await logger.close()` during application shutdown when cleanup is enabled.

## API Reference

### `IDbLogHandler` Interface

Your database handler must implement this interface:

```typescript
interface IDbLogHandler {
  environment: 'development' | 'production' | 'test';
  saveLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): Promise<void>;
  cleanUpLogs(): Promise<number>;
  initialize?(): Promise<void>;
}

interface Logger {
  debug(message: string, meta?: Record<string, unknown>): Promise<void>;
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
```

```typescript
interface LoggerOptions {
  onPersistenceError?: (error: unknown) => void | Promise<void>;
  cleanup?: {
    enabled?: boolean;
    schedule?: string;
    timezone?: string;
  };
}
```

Use `onPersistenceError` to forward database write or cleanup failures to an
alerting or metrics system. The callback is awaited, and errors thrown by the
callback are reported to the console without rejecting the logger operation.

#### Properties

- **`environment`**: `'development' | 'production' | 'test'` - Current environment

#### Methods

- **`saveLog(level, message, meta?)`**: Saves a log entry to the database
  - `level`: Log level (`'debug'`, `'info'`, `'warn'`, `'error'`)
  - `message`: Log message
  - `meta`: Optional metadata object

- **`cleanUpLogs()`**: Deletes old logs from the database
  - Returns the number of deleted logs

- **`initialize()`** _(optional)_: Initialize database connection or setup
  - Called automatically when creating the logger

### `createLogger(handler, options?)`

Creates and configures a logger instance.

#### Parameters

- **`handler`**: `IDbLogHandler` - Your database handler implementation
- **`options`**: `LoggerOptions` _(optional)_ - Configure the cleanup cron job

Set `options.onPersistenceError` to observe database persistence failures.

Cleanup is disabled by default. Set `options.cleanup.enabled` to `true` to enable it. The default schedule is `0 0 * * *`; provide `schedule` and `timezone` to customize it.

#### Returns

A `Promise` that resolves to a logger object with the following methods:

- **`debug(message, meta?)`**: Returns `Promise<void>` after queuing a debug log (only in development)
- **`info(message, meta?)`**: Returns `Promise<void>` after queuing an informational log
- **`warn(message, meta?)`**: Returns `Promise<void>` after queuing a warning log
- **`error(message, meta?)`**: Returns `Promise<void>` after queuing an error log
- **`close()`**: Returns `Promise<void>` after stopping the cleanup cron job and waiting for queued database writes

Await a logger method when the database write must complete before continuing.

## Environment-Based Behavior

### Development Environment

- Log level: `debug`
- Console output: Colorized and pretty-printed
- Debug logs are saved to database
- Cleanup cron job is disabled by default

### Production Environment

- Log level: `info` (debug logs are ignored)
- Console output: Colorized and pretty-printed
- Only info, warn, and error logs are saved
- Cleanup cron job is disabled by default

### Test Environment

- Log level: `debug`
- Console output: Colorized and pretty-printed
- Info, warn, and error logs are saved to the database
- Debug logs are not saved in the test environment
- Cleanup cron job is disabled by default

## Automatic Log Cleanup

Cleanup is disabled by default. Enable it explicitly when creating the logger:

```typescript
const logger = await createLogger(handler, {
  cleanup: {
    enabled: true,
    schedule: '0 0 * * *',
    timezone: 'UTC',
  },
});
```

When enabled, the cron job calls `handler.cleanUpLogs()` according to the configured schedule and timezone. Call `await logger.close()` during shutdown to stop the cron job and wait for pending log writes.

Only one cleanup task is scheduled per handler, even when multiple loggers share
that handler. The task stops after the last logger using it is closed.

This behavior is:

- ❌ **Disabled by default** in every environment
- ✅ **Enabled** only when `options.cleanup.enabled` is `true`

The cleanup logic is implemented in your `cleanUpLogs()` method, giving you full control over what gets deleted.

## Example with MongoDB

```typescript
import { createLogger, Environment, IDbLogHandler, LogLevel } from 'pino-config';
import { MongoClient, Db } from 'mongodb';

class MongoDbLogHandler implements IDbLogHandler {
  environment: Environment;
  private db?: Db;

  constructor(env: Environment) {
    this.environment = env;
  }

  async initialize(): Promise<void> {
    const client = await MongoClient.connect(process.env.MONGO_URL!);
    this.db = client.db('logs');
  }

  async saveLog(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    await this.db!.collection('logs').insertOne({
      level,
      message,
      meta,
      timestamp: new Date(),
    });
  }

  async cleanUpLogs(): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.db!.collection('logs').deleteMany({
      timestamp: { $lt: thirtyDaysAgo },
    });
    return result.deletedCount;
  }
}

const environment: Environment =
  process.env.NODE_ENV === 'production' ||
  process.env.NODE_ENV === 'test' ||
  process.env.NODE_ENV === 'development'
    ? process.env.NODE_ENV
    : 'development';
const handler = new MongoDbLogHandler(environment);

async function main() {
  const logger = await createLogger(handler);
  await logger.info('Application started', { version: '1.0.0' });
}

void main();
```

## TypeScript Support

This package is written in TypeScript and includes full type definitions. No need to install additional `@types` packages.

## Dependencies

- **pino**: Fast and low overhead logging library
- **node-cron**: Cron job scheduler for automatic log cleanup

## Roadmap

### Reliability and release quality

- Prevent or reject log calls after `logger.close()`.
- Verify the generated package by installing its `.tgz` in a temporary project
  and testing both CommonJS and ESM imports.
- Add package metadata for repository, homepage, issue tracker, keywords, and
  supported Node.js versions.

### Observability and resilience

- Use structured JSON output in production and make the pretty console
  transport configurable.
- Add an `onPersistenceError` hook so applications can report failed database
  writes through their own monitoring system.
- Make log levels configurable instead of deriving them exclusively from the
  environment.
- Define a strategy for multiple logger instances to avoid duplicated cleanup
  jobs.
- Add queue limits or backpressure for a high volume of pending database
  writes.

### API improvements

- Extract cleanup settings into a dedicated `CleanupOptions` type.
- Evaluate support for custom environments while retaining predictable default
  behavior.
- Consider Pino-style child loggers and contextual bindings.
- Offer an optional strict persistence mode that propagates database failures.

### Testing and documentation

- Add ESLint and enforce it in CI alongside Prettier.
- Track test coverage and define a minimum threshold.
- Add load and concurrency tests for the persistence queue.
- Add tests for cron schedules and timezones using the real scheduler.
- Document graceful shutdown, persistence-error behavior, and the behavior of
  multiple logger instances.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
