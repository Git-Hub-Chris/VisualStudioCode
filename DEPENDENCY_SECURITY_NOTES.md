# Dependency Security Notes

This document tracks dependencies with OpenSSF Scorecard scores below 3, as
reported by the [Dependency Review](https://github.com/actions/dependency-review-action)
workflow. For each package, it documents the tradeoff and why the dependency is
retained when removal or replacement is not currently feasible.

## Rust (Cargo) Dependencies

### `russh` (via `[patch.crates-io]` in `cli/Cargo.toml`)

- **Reported advisories**: GHSA-7jr8-5gqg-9fqf (OOM DoS, high), GHSA-qqff-4vr4-enp6
  (Terrapin, moderate), GHSA-cqjm-7784-r8w9 (missing overflow checks, moderate)
- **Version in lockfile**: 0.37.1 (from `github.com/microsoft/vscode-russh`)
- **Why retained**: The CLI uses the `tunnels` crate from `microsoft/dev-tunnels`,
  which requires `russh` for SSH connectivity. The project patches `russh` to use
  `microsoft/vscode-russh`, a maintained fork that contains VS Code-specific
  modifications. The fork may include backported fixes not reflected in the version
  number. Switching to upstream russh ≥ 0.44.0 directly is blocked by incompatible
  API changes in `microsoft/dev-tunnels`.
- **Mitigation**: The VS Code tunnel server is only invoked explicitly by the user and
  is not exposed as a network-facing service by default. The `microsoft/vscode-russh`
  fork is actively maintained by the VS Code team.
- **Tracking**: Update when `microsoft/vscode-russh` releases a version ≥ 0.44.0.

## npm Dependencies

The following low-score packages are **transitive dependencies** pulled in by direct
dependencies. They cannot be removed independently and replacing the direct dependency
would require significant refactoring of the build system or core functionality.

### `simple-concat` (OpenSSF score: 2.1)

- **Direct parent**: `simple-get` → `prebuild-install` → `kerberos` (direct dependency)
- **Why retained**: `kerberos` is a required runtime dependency for Kerberos/GSSAPI
  authentication. `prebuild-install` handles prebuilt native binary downloads and uses
  `simple-concat` to buffer HTTP responses. No maintained alternative provides the
  same native binding download behavior.

### `end-of-stream` (OpenSSF score: 2.5)

- **Direct parents**: `pump`, `pumpify`, `async-done`, `duplexify`, `tar-fs`
- **Why retained**: `pump` is a core streaming utility used throughout the build
  system (gulpfiles). `end-of-stream` is a minimal utility to detect stream completion.
  Replacing these would require a complete rewrite of the stream-based build pipeline.

### `es6-error` (OpenSSF score: 2.5)

- **Direct parent**: `global-agent` (optional dep of `@electron/get` → `electron`)
- **Why retained**: `global-agent` is an optional dependency used for proxy support
  in Electron downloads during development builds. Removing it would break proxy
  support in restricted network environments.

### `expand-template` (OpenSSF score: 2.3)

- **Direct parent**: `prebuild-install` → `kerberos`
- **Why retained**: Same reasoning as `simple-concat` above; part of the native
  binding download chain for `kerberos`.

### `extend-shallow` (OpenSSF score: 2.1)

- **Direct parent**: `plugin-error` → `@vscode/gulp-electron`, `gulp-flatmap`,
  `gulp-plumber`
- **Why retained**: Used by gulp plugins in the build system for error formatting.
  These plugins are actively maintained gulp ecosystem packages with no direct
  replacements that avoid `extend-shallow`.

### `dir-compare` (OpenSSF score: 2.1)

- **Direct parent**: `vscode-universal-bundler` (in `build/package.json`)
- **Why retained**: Used for comparing macOS universal binary contents during the
  build process. The `vscode-universal-bundler` package is maintained by the VS Code
  team and is a required build step for macOS universal binaries.

### `ecdsa-sig-formatter` (OpenSSF score: 2.8)

- **Direct parent**: `jwa` → `jsonwebtoken` (in `extensions/microsoft-authentication`)
- **Why retained**: Used by `@azure/msal-node` for JWT token signature formatting in
  the Microsoft Authentication extension. Replacing it would require changing the
  underlying JWT library used by MSAL, which is out of scope for this project.

### `@webassemblyjs/ast` and related `@webassemblyjs/*` packages (OpenSSF score: < 3)

- **Direct parent**: `webpack` (direct devDependency)
- **Why retained**: These packages are internal implementation details of webpack's
  WebAssembly support. Webpack is a core build tool that cannot be easily replaced.
  The `@webassemblyjs/*` packages are maintained by the webpack organization.

### `errno` (OpenSSF score: 2.1)

- **Direct parent**: `memory-fs` → `webpack-stream`
- **Why retained**: `webpack-stream` is used to integrate webpack into the gulp build
  pipeline. `memory-fs` provides an in-memory file system for webpack. No alternative
  webpack/gulp integration exists without `memory-fs`.

### `event-stream` (direct devDependency, transitive deps with low scores)

- **Direct usage**: Used extensively across all gulpfiles for stream merging,
  transformation, and pipeline composition (`es.merge()`, `es.through()`, etc.)
- **Why retained**: `event-stream` is deeply integrated into the entire build system.
  Replacing it would require rewriting all gulpfiles. The package itself has no known
  active vulnerabilities; only its transitive dependencies have low scorecard scores.
- **Note**: Many of event-stream's transitive dependencies (through, fork-stream,
  map-stream, stream-combiner, etc.) have low scores due to being unmaintained
  upstream packages. The functionality they provide is stable and well-tested.

### `ansi-colors` (direct devDependency, OpenSSF score: 2.1)

- **Direct usage**: Used in build system scripts for colored terminal output
  (compilation errors, download progress, task status).
- **Alternatives considered**: `chalk` (OpenSSF score ~6+) has a compatible color API,
  but migrating would require updating ~15 TypeScript build source files and their
  compiled JavaScript counterparts. The package has no known active vulnerabilities.
- **Tracking**: Consider replacing with `chalk` in a dedicated build system cleanup.

### `yauzl` (direct runtime dependency, OpenSSF score: 2.8)

- **Direct usage**: Used for ZIP file extraction throughout the codebase.
- **Why retained**: `yauzl` is a well-established ZIP extraction library. While its
  scorecard is 2.8, it has no known active vulnerabilities. Alternative ZIP libraries
  (`unzipper`, `adm-zip`) do not provide significant security advantages.
- **Note**: The `yazl` companion package (for writing ZIP files, also a direct dep)
  shares the same low-score concern and reasoning.

## References

- [OpenSSF Scorecard](https://securityscorecards.dev/)
- [Dependency Review Action](https://github.com/actions/dependency-review-action)
- [GitHub Advisory Database](https://github.com/advisories)
