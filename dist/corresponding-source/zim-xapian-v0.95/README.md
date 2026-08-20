# Xapian/libzim WebAssembly corresponding source

This directory contains the source archives, license texts, build inputs, and
the exact WebBrain driver used to produce the bundled runtime. The build pins
javascript-libzim v0.95 at commit
`470b36920fba421a4c1a83b326e66d8aa0533870` and Emscripten 3.1.41.

## Rebuild

Install Docker, Node.js, and Git. From the root of this extracted directory run:

```sh
node scripts/build-zim-xapian.mjs --work .build/zim-xapian
```

On Windows, run from WSL2 and place `--work` on the WSL filesystem to avoid
Docker bind-mount clock skew. The driver verifies the pinned upstream commit,
builds the pinned Emscripten image, compiles libzim/Xapian and dependencies from
source, retries the final Wasm optimizer down to `-O1` if necessary, and writes
the runtime plus refreshed SBOM records under `src/{chrome,firefox}/vendor/libzim/`.

Inside a full WebBrain checkout, `npm run build:zim-xapian` invokes the same
driver. The source archives in this directory are the immutable inputs retained
with the release; their sizes and SHA-256 hashes are recorded in `sbom.json`.
