# Package Publish Guardrails

## Motivation

`@risingwave/wavelet-server@0.2.4` was published with `package.json` entry points that referenced `dist/`, but the npm tarball only contained source files under `src/`. Installing the package caused immediate module resolution failures because Node could not find `./dist/index.js`.

Wavelet publishes multiple workspace packages that all point their runtime entry points at compiled output. Publishing must therefore guarantee two things:

1. The package is built before npm snapshots its tarball.
2. The tarball actually contains every file referenced by `main`, `types`, `bin`, and `exports`.

## Design Overview

The fix adds two layers of protection:

1. Workspace package `prepack` scripts build the package before `npm pack` or `npm publish` runs.
2. A repository-level `npm run pack:check` command performs `npm pack --dry-run --json` for each published package and verifies that every published entry path declared in `package.json` is present in the tarball.

The `server` and `cli` packages also gain explicit `files: ["dist"]` allowlists so npm publishes the compiled artifacts rather than raw source trees.

## Key Decisions

- Use `prepack` instead of relying on contributors to remember a manual build step. `prepack` runs for both `npm pack` and `npm publish`, which covers local verification and actual releases.
- Build workspace dependencies explicitly in package-local `prepack` scripts. This keeps package publication reliable even when a dependent workspace has not been built yet.
- Validate tarball contents from declared package metadata instead of hardcoding a static list of files in the checker. That keeps the check aligned with `main`, `types`, `bin`, and `exports` as packages evolve.

## Trade-offs

- `prepack` makes packaging a little slower because it compiles before every tarball creation.
- The tarball checker is an additional maintenance surface, but it is small and directly prevents broken npm releases.
