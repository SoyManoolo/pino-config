import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src'
import type { IDbLogHandler } from '../src/types'

const mocks = vi.hoisted(() => ({
  pino: vi.fn(),
  schedule: vi.fn(),
  consoleLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('pino', () => ({ pino: mocks.pino }))
vi.mock('node-cron', () => ({
  default: { schedule: mocks.schedule },
}))

function createHandler(
  environment: IDbLogHandler['environment'] = 'development',
): IDbLogHandler {
  return {
    environment,
    saveLog: vi.fn().mockResolvedValue(undefined),
    cleanUpLogs: vi.fn().mockResolvedValue(2),
  }
}

describe('createLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pino.mockReturnValue(mocks.consoleLogger)
    mocks.schedule.mockReturnValue({ stop: vi.fn() })
  })

  it('runs the optional initialization before creating the logger', async () => {
    const events: string[] = []
    const handler = createHandler()
    handler.initialize = vi.fn(async () => {
      events.push('initialize')
    })
    mocks.pino.mockImplementation(() => {
      events.push('pino')
      return mocks.consoleLogger
    })

    await createLogger(handler)

    expect(events).toEqual(['initialize', 'pino'])
  })

  it.each([
    ['development', 'debug'],
    ['production', 'info'],
    ['test', 'debug'],
  ] as const)('configures the console level for %s', async (environment, level) => {
    await createLogger(createHandler(environment))

    expect(mocks.pino).toHaveBeenCalledWith(expect.objectContaining({ level }))
  })

  it('only persists debug logs in development', async () => {
    const developmentHandler = createHandler('development')
    const productionHandler = createHandler('production')
    const testHandler = createHandler('test')

    await (await createLogger(developmentHandler)).debug('development')
    await (await createLogger(productionHandler)).debug('production')
    await (await createLogger(testHandler)).debug('test')

    expect(developmentHandler.saveLog).toHaveBeenCalledWith('debug', 'development', undefined)
    expect(productionHandler.saveLog).not.toHaveBeenCalled()
    expect(testHandler.saveLog).not.toHaveBeenCalled()
  })

  it('passes level, message, and metadata to the handler in order', async () => {
    const handler = createHandler()
    const logger = await createLogger(handler)
    const metadata = { requestId: 'abc-123' }

    await logger.warn('Request failed', metadata)

    expect(handler.saveLog).toHaveBeenCalledWith('warn', 'Request failed', metadata)
    expect(mocks.consoleLogger.warn).toHaveBeenCalledWith(metadata, 'Request failed')
  })

  it('swallows handler errors and reports them to the console logger', async () => {
    const handler = createHandler()
    const error = new Error('database unavailable')
    vi.mocked(handler.saveLog).mockRejectedValueOnce(error)
    const logger = await createLogger(handler)

    await expect(logger.error('Write failed')).resolves.toBeUndefined()

    expect(mocks.consoleLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error, level: 'error', message: 'Write failed' }),
      '[LOGGER] Failed to save log to database.',
    )
  })

  it('schedules cleanup, logs its result, and stops the task on close', async () => {
    const handler = createHandler()
    const logger = await createLogger(handler, {
      cleanup: { enabled: true, schedule: '*/5 * * * *', timezone: 'UTC' },
    })
    const callback = mocks.schedule.mock.calls[0][1] as () => Promise<void>

    expect(mocks.schedule).toHaveBeenCalledWith(
      '*/5 * * * *',
      expect.any(Function),
      { timezone: 'UTC' },
    )

    await callback()
    await logger.close()

    expect(handler.cleanUpLogs).toHaveBeenCalledOnce()
    expect(handler.saveLog).toHaveBeenCalledWith(
      'info',
      '[CRON] Logs cleanup executed. Deleted 2 logs.',
      undefined,
    )
    expect(mocks.schedule.mock.results[0].value.stop).toHaveBeenCalledOnce()
  })
})