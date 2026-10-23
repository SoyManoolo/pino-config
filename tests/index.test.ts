import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Writable } from 'node:stream'
import { createLogger, PendingLogWritesLimitError } from '../src'
import type { IDbLogHandler } from '../src/types'

const mocks = vi.hoisted(() => ({
  pino: vi.fn(),
  transport: vi.fn(),
  schedule: vi.fn(),
  consoleLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('pino', () => ({ pino: Object.assign(mocks.pino, { transport: mocks.transport }) }))
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
    mocks.transport.mockImplementation(() => new Writable({
      write(_chunk, _encoding, callback) { callback() },
    }))
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

  it('initializes a shared handler only once across sequential logger creations', async () => {
    const handler = createHandler()
    handler.initialize = vi.fn().mockResolvedValue(undefined)

    await createLogger(handler)
    await createLogger(handler)

    expect(handler.initialize).toHaveBeenCalledOnce()
    expect(mocks.pino).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight initialization between concurrent logger creations', async () => {
    const handler = createHandler()
    let finishInitialization!: () => void
    handler.initialize = vi.fn(() => new Promise<void>((resolve) => {
      finishInitialization = resolve
    }))

    const first = createLogger(handler)
    const second = createLogger(handler)
    await Promise.resolve()

    expect(handler.initialize).toHaveBeenCalledOnce()
    expect(mocks.pino).not.toHaveBeenCalled()

    finishInitialization()
    await Promise.all([first, second])
    expect(mocks.pino).toHaveBeenCalledTimes(2)
  })

  it('retries initialization after a failure', async () => {
    const handler = createHandler()
    const error = new Error('initialization failed')
    handler.initialize = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined)

    await expect(createLogger(handler)).rejects.toBe(error)
    expect(mocks.pino).not.toHaveBeenCalled()

    await createLogger(handler)
    expect(handler.initialize).toHaveBeenCalledTimes(2)
    expect(mocks.pino).toHaveBeenCalledOnce()
  })

  it('ends the transport when Pino creation fails', async () => {
    mocks.pino.mockImplementationOnce(() => { throw new Error('Pino failed') })

    await expect(createLogger(createHandler())).rejects.toThrow('Pino failed')
    const transport = mocks.transport.mock.results[0].value as Writable
    expect(transport.writableEnded).toBe(true)
  })

  it.each([
    ['development', 'debug'],
    ['production', 'info'],
    ['test', 'debug'],
  ] as const)('configures the console level for %s', async (environment, level) => {
    await createLogger(createHandler(environment))

    expect(mocks.pino).toHaveBeenCalledWith(
      expect.objectContaining({ level }),
      mocks.transport.mock.results[0].value,
    )
  })

  it('ends each transport once after its writes, even when close is called repeatedly', async () => {
    const handler = createHandler()
    let finishWrite!: () => void
    vi.mocked(handler.saveLog).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishWrite = resolve }),
    )
    const first = await createLogger(handler)
    const second = await createLogger(handler)
    const firstEnd = vi.spyOn(mocks.transport.mock.results[0].value as Writable, 'end')
    const secondEnd = vi.spyOn(mocks.transport.mock.results[1].value as Writable, 'end')

    const write = first.info('pending')
    await vi.waitFor(() => expect(handler.saveLog).toHaveBeenCalledOnce())
    const firstClose = first.close()
    expect(first.close()).toBe(firstClose)
    await second.close()
    expect(firstEnd).not.toHaveBeenCalled()
    expect(secondEnd).toHaveBeenCalledOnce()

    finishWrite()
    await Promise.all([write, firstClose])
    expect(firstEnd).toHaveBeenCalledOnce()
    await first.close()
    expect(firstEnd).toHaveBeenCalledOnce()
  })

  it('waits for the transport finish event before resolving close', async () => {
    let finishTransport!: () => void
    mocks.transport.mockReturnValueOnce(new Writable({
      write(_chunk, _encoding, callback) { callback() },
      final(callback) { finishTransport = callback },
    }))
    const logger = await createLogger(createHandler())
    let closed = false
    const close = logger.close().then(() => { closed = true })
    await vi.waitFor(() => expect(finishTransport).toBeTypeOf('function'))
    expect(closed).toBe(false)
    finishTransport()
    await close
    expect(closed).toBe(true)
  })

  it('returns a transport close error without ending it twice', async () => {
    const failure = new Error('transport failed')
    const transport = new Writable({
      write(_chunk, _encoding, callback) { callback() },
      final(callback) { callback(failure) },
    })
    mocks.transport.mockReturnValueOnce(transport)
    const end = vi.spyOn(transport, 'end')
    const logger = await createLogger(createHandler())

    await expect(logger.close()).rejects.toBe(failure)
    await expect(logger.close()).rejects.toBe(failure)
    expect(end).toHaveBeenCalledOnce()
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

  it('reports persistence errors through the optional callback', async () => {
    const handler = createHandler()
    const error = new Error('database unavailable')
    const onPersistenceError = vi.fn()
    vi.mocked(handler.saveLog).mockRejectedValueOnce(error)
    const logger = await createLogger(handler, { onPersistenceError })

    await expect(logger.error('Write failed')).resolves.toBeUndefined()

    expect(onPersistenceError).toHaveBeenCalledWith(error)
  })

  it('persists a log awaited by the error callback even when close is requested', async () => {
    const handler = createHandler()
    const failure = new Error('database unavailable')
    let rejectFirst!: (error: Error) => void
    vi.mocked(handler.saveLog).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectFirst = reject }),
    )
    let logger!: Awaited<ReturnType<typeof createLogger>>
    const onPersistenceError = vi.fn(async () => {
      await logger.info('reported persistence failure')
    })
    logger = await createLogger(handler, { onPersistenceError, maxPendingWrites: 1 })

    const firstWrite = logger.error('original log')
    await vi.waitFor(() => expect(handler.saveLog).toHaveBeenCalledOnce())
    const close = logger.close()
    rejectFirst(failure)

    await Promise.all([firstWrite, close])
    expect(onPersistenceError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(handler.saveLog).toHaveBeenNthCalledWith(2, 'info', 'reported persistence failure', undefined)
  })

  it('serializes concurrent writes and close waits for all of them', async () => {
    const handler = createHandler()
    const calls: string[] = []
    const deferredWrites: Array<() => void> = []
    vi.mocked(handler.saveLog).mockImplementation(async (_level, message) => {
      calls.push(message)
      await new Promise<void>((resolve) => deferredWrites.push(resolve))
    })
    const logger = await createLogger(handler)

    const firstWrite = logger.info('first')
    const secondWrite = logger.warn('second')
    let closed = false
    const close = logger.close().then(() => {
      closed = true
    })

    await Promise.resolve()
    expect(calls).toEqual(['first'])
    expect(closed).toBe(false)

    deferredWrites.shift()?.()
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']))
    expect(closed).toBe(false)

    deferredWrites.shift()?.()
    await Promise.all([firstWrite, secondWrite, close])
    expect(calls).toEqual(['first', 'second'])
    expect(closed).toBe(true)
  })

  it('rejects writes beyond the limit without queueing them, then frees capacity', async () => {
    const handler = createHandler()
    const calls: string[] = []
    const release: Array<() => void> = []
    vi.mocked(handler.saveLog).mockImplementation(async (_level, message) => {
      calls.push(message)
      await new Promise<void>((resolve) => release.push(resolve))
    })
    const logger = await createLogger(handler, { maxPendingWrites: 2 })

    const first = logger.info('first')
    const second = logger.info('second')
    await expect(logger.info('rejected', { id: 3 })).rejects.toBeInstanceOf(PendingLogWritesLimitError)
    await Promise.resolve()
    expect(calls).toEqual(['first'])

    release.shift()?.()
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']))

    release.shift()?.()
    await Promise.all([first, second])
    const third = logger.info('third')
    const closing = logger.close()
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second', 'third']))
    release.shift()?.()
    await Promise.all([third, closing])
    expect(calls).not.toContain('rejected')
  })

  it('frees a slot after a failed saveLog and keeps later writes in order', async () => {
    const handler = createHandler()
    let failFirst!: (error: Error) => void
    const calls: string[] = []
    vi.mocked(handler.saveLog).mockImplementation(async (_level, message) => {
      calls.push(message)
      if (message === 'first') {
        await new Promise<void>((_resolve, reject) => { failFirst = reject })
      }
    })
    const onPersistenceError = vi.fn()
    const logger = await createLogger(handler, { maxPendingWrites: 1, onPersistenceError })
    const first = logger.info('first')
    await Promise.resolve()
    await expect(logger.info('rejected')).rejects.toBeInstanceOf(PendingLogWritesLimitError)

    const failure = new Error('database unavailable')
    failFirst(failure)
    await expect(first).resolves.toBeUndefined()
    await expect(logger.info('second')).resolves.toBeUndefined()
    await logger.close()
    expect(calls).toEqual(['first', 'second'])
    expect(onPersistenceError).toHaveBeenCalledWith(failure)
  })

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxPendingWrites %s', async (maxPendingWrites) => {
      await expect(createLogger(createHandler(), { maxPendingWrites })).rejects.toBeInstanceOf(RangeError)
      expect(mocks.pino).not.toHaveBeenCalled()
    },
  )

  it.each(['debug', 'info', 'warn', 'error'] as const)('rejects %s logs after close', async (level) => {
    const handler = createHandler()
    const logger = await createLogger(handler)

    await logger.close()

    await expect(logger[level]('after close')).rejects.toThrow('Logger is closed.')
    expect(handler.saveLog).not.toHaveBeenCalled()
    expect(mocks.consoleLogger[level]).not.toHaveBeenCalled()
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

  it('shares cleanup tasks between loggers using the same handler', async () => {
    const handler = createHandler()
    const firstLogger = await createLogger(handler, { cleanup: { enabled: true } })
    const secondLogger = await createLogger(handler, { cleanup: { enabled: true } })

    expect(mocks.schedule).toHaveBeenCalledOnce()

    await firstLogger.close()
    expect(mocks.schedule.mock.results[0].value.stop).not.toHaveBeenCalled()

    await secondLogger.close()
    expect(mocks.schedule.mock.results[0].value.stop).toHaveBeenCalledOnce()
  })

  it.each([
    [{ enabled: true }, { enabled: true, schedule: '0 0 * * *' }],
    [{ enabled: true, schedule: '0 0 * * *' }, { enabled: true }],
    [{ enabled: true, timezone: 'UTC' }, { enabled: true, schedule: '0 0 * * *', timezone: 'UTC' }],
    [{ enabled: true }, { enabled: true, timezone: '' }],
  ])('shares a task for equivalent cleanup configurations', async (firstCleanup, secondCleanup) => {
    const handler = createHandler()
    const firstLogger = await createLogger(handler, { cleanup: firstCleanup })
    const secondLogger = await createLogger(handler, { cleanup: secondCleanup })

    expect(mocks.schedule).toHaveBeenCalledOnce()

    await firstLogger.close()
    expect(mocks.schedule.mock.results[0].value.stop).not.toHaveBeenCalled()

    await secondLogger.close()
    expect(mocks.schedule.mock.results[0].value.stop).toHaveBeenCalledOnce()
  })

  it.each([
    [{ enabled: true }, { enabled: true, schedule: '*/5 * * * *' }],
    [{ enabled: true, timezone: 'UTC' }, { enabled: true, timezone: 'Europe/Madrid' }],
    [{ enabled: true }, { enabled: true, timezone: 'UTC' }],
    [{ enabled: true }, { enabled: true, schedule: 'not a cron expression' }],
  ])('rejects conflicting cleanup configurations without changing the shared task', async (firstCleanup, secondCleanup) => {
    const handler = createHandler()
    const firstLogger = await createLogger(handler, { cleanup: firstCleanup })
    const task = mocks.schedule.mock.results[0].value

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(createLogger(handler, { cleanup: secondCleanup })).rejects.toThrow(
        'Conflicting cleanup configuration for shared handler: schedule and timezone must match the existing cleanup task.',
      )
    }
    expect(mocks.transport).toHaveBeenCalledOnce()
    expect(mocks.pino).toHaveBeenCalledOnce()
    expect(mocks.schedule).toHaveBeenCalledOnce()
    expect(task.stop).not.toHaveBeenCalled()

    await firstLogger.close()
    expect(task.stop).toHaveBeenCalledOnce()
  })

  it('reports cleanup failures through the handler logger', async () => {
    const handler = createHandler()
    const error = new Error('cleanup unavailable')
    const onPersistenceError = vi.fn()
    vi.mocked(handler.cleanUpLogs).mockRejectedValue(error)
    const logger = await createLogger(handler, {
      cleanup: { enabled: true },
      onPersistenceError,
    })
    const callback = mocks.schedule.mock.calls[0][1] as () => Promise<void>

    await callback()
    await logger.close()

    expect(handler.cleanUpLogs).toHaveBeenCalledOnce()
    expect(onPersistenceError).toHaveBeenCalledWith(error)
    expect(handler.saveLog).toHaveBeenLastCalledWith(
      'error',
      '[CRON] Error in cron job deleting old logs:',
      { error },
    )
  })

  it.each(['success', 'failure'] as const)(
    'reports a %s cleanup correctly when the log queue is full',
    async (outcome) => {
      const handler = createHandler()
      const cleanupError = new Error('cleanup unavailable')
      if (outcome === 'failure') {
        vi.mocked(handler.cleanUpLogs).mockRejectedValueOnce(cleanupError)
      }
      const onPersistenceError = vi.fn()
      const logger = await createLogger(handler, {
        cleanup: { enabled: true },
        maxPendingWrites: 1,
        onPersistenceError,
      })
      await vi.waitFor(async () => { await logger.info('drain scheduling log') })

      let finishWrite!: () => void
      vi.mocked(handler.saveLog).mockImplementationOnce(
        () => new Promise<void>((resolve) => { finishWrite = resolve }),
      )
      const occupyingWrite = logger.info('occupy queue')
      await vi.waitFor(() => expect(handler.saveLog).toHaveBeenCalledTimes(3))
      const callback = mocks.schedule.mock.calls[0][1] as () => Promise<void>
      await callback()

      expect(handler.cleanUpLogs).toHaveBeenCalledOnce()
      expect(onPersistenceError).toHaveBeenCalledTimes(1)
      if (outcome === 'success') {
        expect(onPersistenceError.mock.calls[0][0]).toBeInstanceOf(PendingLogWritesLimitError)
      } else {
        expect(onPersistenceError).toHaveBeenCalledWith(cleanupError)
      }
      expect(handler.saveLog).toHaveBeenCalledTimes(3)

      finishWrite()
      await occupyingWrite
      await logger.close()
    },
  )

  it.each([
    ['invalid cron expression', { schedule: 'not a cron expression' }],
    ['invalid timezone', { timezone: 'Not/A_Timezone' }],
  ])('propagates %s errors from node-cron', async (_description, cleanup) => {
    mocks.schedule.mockImplementationOnce((schedule, _callback, options) => {
      const matchesSchedule = 'schedule' in cleanup && schedule === cleanup.schedule
      const matchesTimezone = 'timezone' in cleanup && options?.timezone === cleanup.timezone
      if (matchesSchedule || matchesTimezone) {
        throw new Error('Invalid cron configuration')
      }

      return { stop: vi.fn() }
    })

    await expect(createLogger(createHandler(), { cleanup: { enabled: true, ...cleanup } }))
      .rejects.toThrow('Invalid cron configuration')
    expect((mocks.transport.mock.results[0].value as Writable).writableEnded).toBe(true)
  })
})
