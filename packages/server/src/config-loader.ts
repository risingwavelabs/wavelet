import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { WaveletConfig } from '@risingwave/wavelet'

export async function loadConfig(configPath: string): Promise<WaveletConfig> {
  const abs = resolve(configPath)
  const mod = await import(pathToFileURL(abs).href)

  // Handle various module formats:
  // - ESM: mod.default is the config
  // - CJS interop: mod.default.default is the config
  // - Plain object: mod itself is the config
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
