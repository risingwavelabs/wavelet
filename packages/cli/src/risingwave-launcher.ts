import { execSync, spawn, type ChildProcess } from 'node:child_process'
import pg from 'pg'

const { Client } = pg

export async function ensureRisingWave(connectionString: string): Promise<ChildProcess | null> {
  // Try to connect to existing RisingWave
  if (await isReachable(connectionString)) {
    console.log('RisingWave is already running.')
    return null
  }

  console.log('RisingWave is not reachable. Attempting to start...')

  // Try native binary first, then docker
  const binary = findBinary()
  if (binary) {
    return startNative(binary)
  }

  if (hasDocker()) {
    return startDocker()
  }

  console.error(
    'Could not start RisingWave.\n\n' +
    'Install one of:\n' +
    '  brew tap risingwavelabs/risingwave && brew install risingwave\n' +
    '  docker pull risingwavelabs/risingwave:latest\n\n' +
    'Or start RisingWave manually and re-run wavelet dev.'
  )
  process.exit(1)
}

async function isReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    return true
  } catch {
    return false
  }
}

function findBinary(): string | null {
  try {
    const path = execSync('which risingwave', { encoding: 'utf-8' }).trim()
    return path || null
  } catch {
    return null
  }
}

function hasDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function startNative(binaryPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    console.log(`Starting RisingWave (${binaryPath})...`)
    const child = spawn(binaryPath, ['playground'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    let started = false

    const onData = (data: Buffer) => {
      const text = data.toString()
      if (!started && text.includes('ready to accept connections')) {
        started = true
        console.log('RisingWave started (playground mode).')
        resolve(child)
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (err) => {
      if (!started) reject(err)
    })

    child.on('exit', (code) => {
      if (!started) reject(new Error(`RisingWave exited with code ${code}`))
    })

    // Fallback: poll for connectivity
    const poll = setInterval(async () => {
      if (started) {
        clearInterval(poll)
        return
      }
      if (await isReachable('postgres://root@localhost:4566/dev')) {
        started = true
        clearInterval(poll)
        console.log('RisingWave started (playground mode).')
        resolve(child)
      }
    }, 1000)

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!started) {
        clearInterval(poll)
        child.kill()
        reject(new Error('RisingWave failed to start within 30 seconds.'))
      }
    }, 30000)
  })
}

function startDocker(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    console.log('Starting RisingWave via Docker...')

    // Remove stale container if exists
    try {
      execSync('docker rm -f wavelet-risingwave', { stdio: 'ignore' })
    } catch {}

    const child = spawn('docker', [
      'run', '--name', 'wavelet-risingwave',
      '-p', '4566:4566',
      'risingwavelabs/risingwave:latest',
      'playground',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    let started = false

    // Poll for connectivity
    const poll = setInterval(async () => {
      if (started) {
        clearInterval(poll)
        return
      }
      if (await isReachable('postgres://root@localhost:4566/dev')) {
        started = true
        clearInterval(poll)
        console.log('RisingWave started via Docker.')
        resolve(child)
      }
    }, 1000)

    child.on('error', (err) => {
      if (!started) {
        clearInterval(poll)
        reject(err)
      }
    })

    child.on('exit', (code) => {
      if (!started) {
        clearInterval(poll)
        reject(new Error(`Docker exited with code ${code}`))
      }
    })

    setTimeout(() => {
      if (!started) {
        clearInterval(poll)
        child.kill()
        reject(new Error('RisingWave Docker container failed to start within 60 seconds.'))
      }
    }, 60000)
  })
}
