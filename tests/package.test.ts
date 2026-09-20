import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmExecutable = process.env.npm_execpath
  ? { command: process.execPath, prefix: [process.env.npm_execpath] }
  : { command: npmCommand, prefix: [] }

function runNpm(args: string[], options: Parameters<typeof execFileSync>[2] = {}) {
  return execFileSync(npmExecutable.command, [...npmExecutable.prefix, ...args], {
    ...options,
    shell: process.platform === 'win32' && !process.env.npm_execpath,
  })
}

describe('published package', () => {
  it('installs the tarball and supports CommonJS and ESM imports', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pino-config-'))

    try {
      runNpm(['run', 'build'], {
        cwd: process.cwd(),
        stdio: 'ignore',
      })

      const packOutput = runNpm(
        ['pack', '--json', '--pack-destination', temporaryDirectory],
        { cwd: process.cwd(), encoding: 'utf8' },
      )
      const packResult = JSON.parse(packOutput) as
        | { filename: string }
        | Array<{ filename: string }>
        | Record<string, { filename: string }>
      const packMetadata = Array.isArray(packResult)
        ? packResult[0]
        : 'filename' in packResult
          ? packResult
          : Object.values(packResult)[0]
      const { filename } = packMetadata
      const tarballPath = join(temporaryDirectory, filename)

      writeFileSync(
        join(temporaryDirectory, 'package.json'),
        JSON.stringify({ name: 'package-consumer', private: true }),
      )
      runNpm(
        [
          'install',
          '--ignore-scripts',
          '--offline',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          tarballPath,
        ],
        { cwd: temporaryDirectory, stdio: 'ignore' },
      )

      const commonJsOutput = execFileSync(
        process.execPath,
        ['-e', "if (typeof require('pino-config').createLogger !== 'function') process.exit(1)"],
        { cwd: temporaryDirectory, encoding: 'utf8' },
      )
      const esmOutput = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { createLogger } from 'pino-config'; if (typeof createLogger !== 'function') process.exit(1)",
        ],
        { cwd: temporaryDirectory, encoding: 'utf8' },
      )

      expect(commonJsOutput).toBe('')
      expect(esmOutput).toBe('')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 30000)
})