import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src'
import type { IDbLogHandler } from '../src/types'

// Keep the real Croner validator; invalid options must never reach Pino.
const transport = vi.hoisted(() => vi.fn())
vi.mock('pino', () => ({ pino: Object.assign(vi.fn(), { transport }) }))

describe('cleanup validation with Croner', () => {
  it.each([
    { schedule: 'not a cron expression' },
    { timezone: 'Not/A_Timezone' },
  ])('rejects invalid options before initializing: %j', async (cleanup) => {
    const handler: IDbLogHandler = {
      environment: 'test',
      initialize: vi.fn().mockResolvedValue(undefined),
      saveLog: vi.fn().mockResolvedValue(undefined),
      cleanUpLogs: vi.fn().mockResolvedValue(0),
    }

    await expect(createLogger(handler, { cleanup: { enabled: true, ...cleanup } }))
      .rejects.toThrow()
    expect(handler.initialize).not.toHaveBeenCalled()
    expect(handler.cleanUpLogs).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
})
