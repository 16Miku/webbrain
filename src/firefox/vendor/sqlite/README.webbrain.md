# Vendored SQLite Wasm runtime

- Package: `@sqlite.org/sqlite-wasm`
- Version: `3.53.0-build1`
- Upstream: <https://github.com/sqlite/sqlite-wasm>
- Files: `dist/index.mjs` and `dist/sqlite3.wasm` from the published npm package, unmodified
- `index.mjs` SHA-256: `f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154`
- `sqlite3.wasm` SHA-256: `02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312`
- License: Apache-2.0 (see `LICENSE`); the underlying SQLite core is public domain

WebBrain initializes the `opfs-sahpool` VFS in a dedicated module worker. That
VFS does not require cross-origin isolation and keeps all database I/O off the
UI thread. The runtime is bundled with the extension; no executable code is
fetched at runtime.
