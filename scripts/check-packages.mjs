import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

const packages = [
  'packages/config',
  'packages/sdk',
  'packages/server',
  'packages/cli',
  'packages/mcp'
];
const npmCacheDir = path.join(os.tmpdir(), 'wavelet-npm-cache');

function normalizePublishedPath(publishedPath) {
  if (typeof publishedPath !== 'string') {
    return null;
  }

  if (publishedPath.startsWith('./')) {
    return publishedPath.slice(2);
  }

  if (publishedPath.startsWith('/')) {
    return null;
  }

  return publishedPath;
}

function collectPublishedPaths(pkgJson) {
  const publishedPaths = new Set();

  if (typeof pkgJson.main === 'string') {
    publishedPaths.add(pkgJson.main);
  }

  if (typeof pkgJson.types === 'string') {
    publishedPaths.add(pkgJson.types);
  }

  if (typeof pkgJson.bin === 'string') {
    publishedPaths.add(pkgJson.bin);
  }

  if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    for (const value of Object.values(pkgJson.bin)) {
      if (typeof value === 'string') {
        publishedPaths.add(value);
      }
    }
  }

  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    for (const value of Object.values(pkgJson.exports)) {
      if (typeof value === 'string') {
        publishedPaths.add(value);
        continue;
      }

      if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) {
          if (typeof nested === 'string') {
            publishedPaths.add(nested);
          }
        }
      }
    }
  }

  return [...publishedPaths]
    .map(normalizePublishedPath)
    .filter(Boolean);
}

for (const packageDir of packages) {
  const packageJsonPath = path.join(repoRoot, packageDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const expectedPaths = collectPublishedPaths(pkgJson);

  const packOutput = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json'],
    {
      cwd: path.join(repoRoot, packageDir),
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir
      }
    }
  );

  const packResult = JSON.parse(packOutput);
  const tarballFiles = new Set(packResult[0].files.map((file) => file.path));
  const missingPaths = expectedPaths.filter((expectedPath) => !tarballFiles.has(expectedPath));

  if (missingPaths.length > 0) {
    const message = `${pkgJson.name} is missing published entry files: ${missingPaths.join(', ')}`;
    throw new Error(message);
  }

  console.log(`${pkgJson.name}: ok`);
}
