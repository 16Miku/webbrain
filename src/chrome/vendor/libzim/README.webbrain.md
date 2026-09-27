# Vendored Xapian/libzim WebAssembly runtime

Built from source by `scripts/build-zim-xapian.mjs`. Do not hand-copy an
upstream release asset here: WebBrain cannot provide corresponding source for a
binary it did not build. See `docs/offline-rag-licensing.md`.

- Upstream: https://github.com/openzim/javascript-libzim.git `v0.95` (`470b36920fba421a4c1a83b326e66d8aa0533870`)
- Toolchain: Emscripten 3.1.41
- libzim 9.8.1, Xapian 1.4.31, ICU 73.2, zstd 1.5.7, xz 5.2.6, zlib 1.3.1

- `libzim-wasm.js`: 138780 bytes, SHA-256 `cd5073842f0405eaaf51b6faf8703fff7fe518e7b162d3ebe5cb9a90634c91bf`
- `libzim-wasm.wasm`: 2138488 bytes, SHA-256 `f4fb53249b3ec9a4c7cd6c275b2323d6df1820afbc3d4f139fe165fc94c0026c`

Linked at `-O2` rather than `-O3`, because Emscripten's wasm-opt
could not optimize this module at the higher level. The module is correct and
somewhat larger.

## License

This runtime is GPL. Any release artifact that bundles it is conveyed under
**GPL-3.0-or-later**, which is why the store packages carry that license even
though the repository itself stays MIT. Complete corresponding source for these
binaries is published as a `webbrain-zim-xapian-*-corresponding-source.zip`
release asset and must accompany every release.

To rebuild: `npm run build:zim-xapian`
