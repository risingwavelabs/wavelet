#!/usr/bin/env node

const command = process.argv[2]

const HELP = `
wavelet - Subscribe to computed results, not raw rows.

Usage:
  wavelet <command> [options]

Commands:
  dev        Start local development server
  generate   Generate typed client from query definitions
  push       Sync query definitions to Wavelet server
  status     Show current configuration and connection status
  init       Initialize a new Wavelet project

Options:
  --config   Path to wavelet.config.ts (default: ./wavelet.config.ts)
  --json     Output in JSON format
  --help     Show this help message

Examples:
  wavelet init
  wavelet dev
  wavelet generate
  wavelet push
`

async function main() {
  switch (command) {
    case 'init':
      await runInit()
      break
    case 'dev':
      await runDev()
      break
    case 'generate':
      await runGenerate()
      break
    case 'push':
      await runPush()
      break
    case 'status':
      await runStatus()
      break
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP)
      break
    default:
      console.error(`Unknown command: '${command}'`)
      console.error(`Run 'wavelet --help' for available commands.`)
      process.exit(1)
  }
}

async function runInit() {
  const { writeFileSync, existsSync } = await import('node:fs')

  if (existsSync('wavelet.config.ts')) {
    console.log('wavelet.config.ts already exists. Skipping.')
    return
  }

  writeFileSync('wavelet.config.ts', `import { defineConfig, sql } from '@risingwave/wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

  events: {
    // Define your events here
    // game_events: {
    //   columns: {
    //     user_id: 'string',
    //     action: 'string',
    //     value: 'int',
    //   }
    // }
  },

  queries: {
    // Define your queries (materialized views) here
    // leaderboard: sql\`
    //   SELECT user_id, SUM(value) as total
    //   FROM game_events
    //   GROUP BY user_id
    //   ORDER BY total DESC
    //   LIMIT 100
    // \`,
  },
})
`)

  console.log('Created wavelet.config.ts')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Edit wavelet.config.ts to define your events and queries')
  console.log('  2. Run: wavelet dev')
}

async function runDev() {
  const { loadConfig } = await import('./config-loader.js')
  const { ensureRisingWave } = await import('./risingwave-launcher.js')
  const configPath = getConfigPath()

  console.log(`Loading config from ${configPath}...`)
  const config = await loadConfig(configPath)

  // Ensure RisingWave is running
  const rwProcess = await ensureRisingWave(config.database)

  // Sync DDL before starting server
  const { DdlManager, WaveletServer } = await import('@risingwave/wavelet-server')
  const ddl = new DdlManager(config.database)
  await ddl.connect()

  console.log('\nSyncing events and queries...')
  const actions = await ddl.sync(config)
  printDdlActions(actions)
  await ddl.close()

  // Start server
  const server = new WaveletServer(config)
  await server.start()

  const shutdown = async () => {
    console.log('\nShutting down...')
    await server.stop()
    if (rwProcess) {
      console.log('Stopping RisingWave...')
      rwProcess.kill()
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function runGenerate() {
  const { loadConfig } = await import('./config-loader.js')
  const { generateClient } = await import('./codegen.js')
  const configPath = getConfigPath()

  console.log(`Loading config from ${configPath}...`)
  const config = await loadConfig(configPath)

  await generateClient(config)
  console.log('Generated .wavelet/client.ts')
}

async function runPush() {
  const { loadConfig } = await import('./config-loader.js')
  const configPath = getConfigPath()

  console.log(`Loading config from ${configPath}...`)
  const config = await loadConfig(configPath)

  const { DdlManager } = await import('@risingwave/wavelet-server')
  const ddl = new DdlManager(config.database)
  await ddl.connect()

  const actions = await ddl.sync(config)
  await ddl.close()

  const isJson = process.argv.includes('--json')
  if (isJson) {
    console.log(JSON.stringify({ actions }))
  } else {
    printDdlActions(actions)
  }
}

async function runStatus() {
  const { loadConfig } = await import('./config-loader.js')
  const configPath = getConfigPath()

  try {
    const config = await loadConfig(configPath)
    const eventCount = Object.keys(config.events ?? config.streams ?? {}).length
    const queryCount = Object.keys(config.queries ?? config.views ?? {}).length

    console.log(`Config:   ${configPath}`)
    console.log(`Database: ${config.database.replace(/\/\/[^@]+@/, '//***@')}`)
    console.log(`Events:   ${eventCount}`)
    console.log(`Queries:  ${queryCount}`)

    if (queryCount > 0) {
      console.log('\nQueries:')
      for (const name of Object.keys(config.queries ?? config.views ?? {})) {
        console.log(`  - ${name}`)
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

function printDdlActions(actions: { type: string; resource: string; name: string; detail?: string }[]): void {
  const changed = actions.filter(a => a.type !== 'unchanged')
  const unchanged = actions.filter(a => a.type === 'unchanged')

  for (const action of actions) {
    const icon = action.type === 'create' ? '+' : action.type === 'delete' ? '-' : ' '
    const label = `${action.resource} '${action.name}'`
    const detail = action.detail ? ` (${action.detail})` : ''

    if (action.type === 'unchanged') {
      console.log(`  ${icon} ${label}`)
    } else if (action.type === 'create') {
      console.log(`  ${icon} ${label} - created${detail}`)
    } else if (action.type === 'delete') {
      console.log(`  ${icon} ${label} - removed${detail}`)
    }
  }

  console.log(`\n${changed.length} changed, ${unchanged.length} unchanged`)
}

function getConfigPath(): string {
  const idx = process.argv.indexOf('--config')
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
  }
  return './wavelet.config.ts'
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
