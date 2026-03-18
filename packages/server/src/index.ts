export { WaveletServer } from './server.js'
export { loadConfig } from './config-loader.js'
export { DdlManager } from './ddl-manager.js'
export type { DdlAction } from './ddl-manager.js'

async function main() {
  const { loadConfig } = await import('./config-loader.js')
  const { WaveletServer } = await import('./server.js')

  const configPath = process.argv[2] || './wavelet.config.ts'
  const config = await loadConfig(configPath)

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

// Only run main() when executed directly, not when imported as a library
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
}
