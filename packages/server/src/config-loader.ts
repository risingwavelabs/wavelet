import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { WaveletConfig } from '@risingwave/wavelet'

export async function loadConfig(configPath: string): Promise<WaveletConfig> {
  const abs = resolve(configPath)
  const mod = await import(pathToFileURL(abs).href)
  const config = mod.default ?? mod

  if (!config.database) {
    throw new Error(
      `wavelet.config.ts must export a config with a 'database' field.\n` +
      `Example:\n` +
      `  import { defineConfig } from '@risingwave/wavelet'\n` +
      `  export default defineConfig({ database: 'postgres://...' })`
    )
  }

  return config
}
