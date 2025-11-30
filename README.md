# pino-config

Custom Pino configuration for database logging with automatic cleanup and environment-based log levels.

## Features

- 🎨 Pretty logging with colored output for development
- 💾 Database logging integration through custom handlers
- 🧹 Automatic log cleanup with configurable cron jobs
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
import { IDbLogHandler } from 'pino-config';

class MyDatabaseHandler implements IDbLogHandler {
  environment: string;

  constructor(env: string) {
    this.environment = env;
  }

  async initialize(): Promise<void> {
    // Optional: Setup database connection, create tables, etc.
    console.log('Database initialized');
  }

  async saveLog(level: string, message: string, meta?: object): Promise<void> {
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

const handler = new MyDatabaseHandler(process.env.NODE_ENV || 'development');
const logger = createLogger(handler);

// Use the logger
logger.debug('Debug message', { userId: 123 });
logger.info('User logged in', { username: 'john' });
logger.warn('Deprecated API called', { endpoint: '/old-api' });
logger.error('Database connection failed', { error: 'Connection timeout' });
```

## API Reference

### `IDbLogHandler` Interface

Your database handler must implement this interface:

```typescript
interface IDbLogHandler {
  environment: string;
  saveLog(level: string, message: string, meta?: object): Promise<void>;
  cleanUpLogs(): Promise<number>;
  initialize?(): Promise<void>;
}
```

#### Properties

- **`environment`**: `string` - Current environment (`'development'`, `'production'`, `'test'`, etc.)

#### Methods

- **`saveLog(level, message, meta?)`**: Saves a log entry to the database
  - `level`: Log level (`'debug'`, `'info'`, `'warn'`, `'error'`)
  - `message`: Log message
  - `meta`: Optional metadata object

- **`cleanUpLogs()`**: Deletes old logs from the database
  - Returns the number of deleted logs

- **`initialize()`** _(optional)_: Initialize database connection or setup
  - Called automatically when creating the logger

### `createLogger(handler)`

Creates and configures a logger instance.

#### Parameters

- **`handler`**: `IDbLogHandler` - Your database handler implementation

#### Returns

A logger object with the following methods:

- **`debug(message, meta?)`**: Log debug messages (only in development)
- **`info(message, meta?)`**: Log informational messages
- **`warn(message, meta?)`**: Log warning messages
- **`error(message, meta?)`**: Log error messages

## Environment-Based Behavior

### Development Environment

- Log level: `debug`
- Console output: Colorized and pretty-printed
- Debug logs are saved to database
- Cron job for cleanup is active

### Production Environment

- Log level: `info` (debug logs are ignored)
- Console output: Colorized and pretty-printed
- Only info, warn, and error logs are saved
- Cron job for cleanup is active

### Test Environment

- Log level: `debug`
- Console output: Colorized and pretty-printed
- All logs are saved to database
- Cron job is **disabled** to avoid interference with tests

## Automatic Log Cleanup

By default, a cron job runs daily at **00:00** to clean up old logs by calling `handler.cleanUpLogs()`.

This behavior is:
- ✅ **Active** in `development` and `production` environments
- ❌ **Disabled** in `test` environment

The cleanup logic is implemented in your `cleanUpLogs()` method, giving you full control over what gets deleted.

## Example with MongoDB

```typescript
import { createLogger, IDbLogHandler } from 'pino-config';
import { MongoClient, Db } from 'mongodb';

class MongoDbLogHandler implements IDbLogHandler {
  environment: string;
  private db?: Db;

  constructor(env: string) {
    this.environment = env;
  }

  async initialize(): Promise<void> {
    const client = await MongoClient.connect(process.env.MONGO_URL!);
    this.db = client.db('logs');
  }

  async saveLog(level: string, message: string, meta?: object): Promise<void> {
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

const handler = new MongoDbLogHandler(process.env.NODE_ENV || 'development');
const logger = createLogger(handler);

logger.info('Application started', { version: '1.0.0' });
```

## TypeScript Support

This package is written in TypeScript and includes full type definitions. No need to install additional `@types` packages.

## Dependencies

- **pino**: Fast and low overhead logging library
- **node-cron**: Cron job scheduler for automatic log cleanup

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
