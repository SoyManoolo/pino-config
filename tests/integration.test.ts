import { describe, expect, it } from 'vitest'
import { createLogger } from '../src'
import type { IDbLogHandler } from '../src/types'

describe('pino-pretty integration', () => {
  it('creates the real pretty transport and writes a log', async () => {
    const savedLogs: Array<{ level: string; message: string }> = []
    const handler: IDbLogHandler = {
      environment: 'test',
      saveLog: async (level, message) => {
        savedLogs.push({ level, message })
      },
      cleanUpLogs: async () => 0,
    }
    const logger = await createLogger(handler)

    await logger.info('real pino-pretty transport')
    await logger.close()

    expect(savedLogs).toEqual([
      { level: 'info', message: 'real pino-pretty transport' },
    ])
  })
})