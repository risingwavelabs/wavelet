#!/usr/bin/env node

const command = process.argv[2]

const HELP = `
wavelet — Subscribe to computed results, not raw rows.

Usage:
  wavelet <command> [options]

Commands:
  dev        Start local development server
  generate   Generate typed client from view definitions
  push       Sync view definitions to Wavelet server
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

  writeFileSync('wavelet.config.ts', `import { defineConfig, sql } from 'wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

  streams: {
    // Define your event streams here
    // events: {
    //   columns: {
    //     user_id: 'string',
    //     action: 'string',
    //     value: 'int',
    //   }
    // }
  },

  views: {
    // Define your materialized views here
    // leaderboard: sql\`
    //   SELECT user_id, SUM(value) as total
    //   FROM events
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
  console.log('  1. Edit wavelet.config.ts to define your streams and views')
  console.log('  2. Run: wavelet dev')
}

async function runDev() {
  const { loadConfig } = await import('./config-loader.js')
  const configPath = getConfigPath()

  console.log(`Loading config from ${configPath}...`)
  const config = await loadConfig(configPath)

  const { WaveletServer } = await import('@wavelet/server')
  const server = new WaveletServer(config)
  await server.start()

  const shutdown = async () => {
    console.log('\nShutting down...')
    await server.stop()
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

  const pg = await import('pg')
  const client = new pg.default.Client({ connectionString: config.database })
  await client.connect()

  const isJson = process.argv.includes('--json')
  const results: { name: string; type: string; action: string }[] = []

  // Sync streams (CREATE TABLE IF NOT EXISTS)
  for (const [name, stream] of Object.entries(config.streams ?? {})) {
    const colDefs = Object.entries(stream.columns).map(([col, type]) => {
      const pgType = { string: 'TEXT', int: 'INT', float: 'FLOAT', boolean: 'BOOLEAN', timestamp: 'TIMESTAMPTZ', json: 'JSONB' }[type] ?? 'TEXT'
      return `${col} ${pgType}`
    }).join(', ')

    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${name} (${colDefs})`)
      results.push({ name, type: 'stream', action: 'synced' })
      if (!isJson) console.log(`✓ Stream '${name}' — synced`)
    } catch (err: any) {
      results.push({ name, type: 'stream', action: `error: ${err.message}` })
      if (!isJson) console.error(`✗ Stream '${name}' — ${err.message}`)
    }
  }

  // Sync views (CREATE OR REPLACE)
  for (const [name, viewDef] of Object.entries(config.views ?? {})) {
    const query = '_tag' in viewDef ? viewDef.text : viewDef.query.text
    try {
      await client.query(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${name} AS ${query}`)
      results.push({ name, type: 'view', action: 'synced' })
      if (!isJson) console.log(`✓ View '${name}' — synced`)
    } catch (err: any) {
      results.push({ name, type: 'view', action: `error: ${err.message}` })
      if (!isJson) console.error(`✗ View '${name}' — ${err.message}`)
    }
  }

  if (isJson) {
    console.log(JSON.stringify({ results }))
  }

  await client.end()
}

async function runStatus() {
  const { loadConfig } = await import('./config-loader.js')
  const configPath = getConfigPath()

  try {
    const config = await loadConfig(configPath)
    const streamCount = Object.keys(config.streams ?? {}).length
    const viewCount = Object.keys(config.views ?? {}).length

    console.log(`Config:   ${configPath}`)
    console.log(`Database: ${config.database.replace(/\/\/[^@]+@/, '//***@')}`)
    console.log(`Streams:  ${streamCount}`)
    console.log(`Views:    ${viewCount}`)

    if (viewCount > 0) {
      console.log('\nViews:')
      for (const name of Object.keys(config.views ?? {})) {
        console.log(`  - ${name}`)
      }
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
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
