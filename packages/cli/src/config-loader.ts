import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import type { WaveletConfig } from '@risingwave/wavelet'

export async function loadConfig(configPath: string): Promise<WaveletConfig> {
  const abs = resolve(configPath)

  // For .ts files, use tsx to evaluate the config
  if (abs.endsWith('.ts')) {
    return loadTsConfig(abs)
  }

  // For .js/.mjs files, use dynamic import directly
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(abs).href)
  return unwrapConfig(mod)
}

function loadTsConfig(absPath: string): WaveletConfig {
  // Use tsx to evaluate the TypeScript config and extract the result as JSON
  const script = `
    import('${absPath}').then(mod => {
      let config = mod.default ?? mod;
      if (config && typeof config === 'object' && 'default' in config) config = config.default;
      process.stdout.write(JSON.stringify(config));
    }).catch(err => {
      process.stderr.write(err.message);
      process.exit(1);
    });
  `

  try {
    const result = execSync(`npx tsx -e "${script.replace(/"/g, '\\"')}"`, {
      cwd: resolve(absPath, '..'),
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const config = JSON.parse(result)
    if (!config || !config.database) {
      throw new Error('Config missing database field')
    }
    return config
  } catch (err: any) {
    throw new Error(
      `Failed to load ${absPath}.\n` +
      `Make sure tsx is installed: npm install tsx\n` +
      `Error: ${err.stderr || err.message}`
    )
  }
}

function unwrapConfig(mod: any): WaveletConfig {
  let config = mod.default ?? mod
  if (config && typeof config === 'object' && 'default' in config) {
    config = config.default
  }

  if (!config || !config.database) {
    throw new Error(
      `wavelet.config.ts must export a config with a 'database' field.\n` +
      `Example:\n` +
      `  import { defineConfig } from '@risingwave/wavelet'\n` +
      `  export default defineConfig({ database: 'postgres://...' })`
    )
  }

  return config
}
