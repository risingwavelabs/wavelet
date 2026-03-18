import { loadConfig } from './config-loader.js'
import { WaveletServer } from './server.js'

async function main() {
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

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
