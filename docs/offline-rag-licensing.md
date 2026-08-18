# Offline Wikipedia full-text licensing decision

Status: **BLOCKED — explicit repository-owner decision required**  
Scope: the Xapian/libzim WebAssembly runtime only. WebBrain currently ships no
`javascript-libzim`, libzim, or Xapian code. Its built-in ZIM title lookup remains
available and is reported as `title-only-fallback`, not full-text search.

This is an engineering distribution record, not legal advice.

## Proposed, pinned runtime

The candidate is
[`openzim/javascript-libzim` v0.95](https://github.com/openzim/javascript-libzim/releases/tag/v0.95),
commit `470b36920fba421a4c1a83b326e66d8aa0533870`. The upstream release was
published on 2026-08-06 and updates libzim to 9.8.1. Its JavaScript API is still
documented by upstream as unstable before 1.0.

The only candidate binary asset is `libzim_wasm_0.95.zip`:

- exact size: `4,671,056` bytes
- SHA-256: `896e4eab4986670ae9c0858312fa5225436e3498990c45df752e0be46eb4fe3d`
- upstream URL: `https://github.com/openzim/javascript-libzim/releases/download/v0.95/libzim_wasm_0.95.zip`

Do not copy that asset into either extension until the decision below is signed
off and the corresponding-source procedure has been completed.

For a reproducible source build, WebBrain pins the versions declared by the
v0.95 source Makefile and workflow:

| Component | Pinned version | License and canonical text |
| --- | --- | --- |
| javascript-libzim | 0.95 / commit above | GPL-3.0-or-later; [`LICENSE`](https://github.com/openzim/javascript-libzim/blob/470b36920fba421a4c1a83b326e66d8aa0533870/LICENSE) |
| libzim | 9.8.1 | GPL-2.0-or-later; [`COPYING`](https://github.com/openzim/libzim/blob/9.8.1/COPYING) |
| Xapian Core | 1.4.31 | GPL-2.0-or-later; [`COPYING`](https://github.com/xapian/xapian/blob/v1.4.31/xapian-core/COPYING) |
| XZ / liblzma | 5.2.6 | public-domain core with per-file exceptions; [`COPYING`](https://github.com/tukaani-project/xz/blob/v5.2.6/COPYING) |
| zlib | 1.3.1 | Zlib; [`LICENSE`](https://github.com/madler/zlib/blob/v1.3.1/LICENSE) |
| Zstandard | 1.5.7 | BSD-3-Clause or GPL-2.0; [`LICENSE`](https://github.com/facebook/zstd/blob/v1.5.7/LICENSE) |
| ICU | 73.2 | Unicode-DFS-2016; [`LICENSE`](https://github.com/unicode-org/icu/blob/release-73-2/icu4c/LICENSE) |
| Emscripten build image | 3.1.41 | MIT/NCSA; [`LICENSE`](https://github.com/emscripten-core/emscripten/blob/3.1.41/LICENSE) |

The versions above describe the reproducible **source-build path**, not a claim
that an opaque upstream ZIP is a complete software bill of materials. Before a
release, CI must build from these sources, archive every input and patch, emit an
SBOM, and verify the output hashes. If the release asset is used instead, its
producer must first provide an equivalent exact SBOM and complete corresponding
source for that binary.

## Linking and packaging approach if approved

The runtime would be compiled to Wasm with libzim, Xapian, liblzma, zlib,
Zstandard, and ICU statically linked into the module. The Wasm, worker glue, and
all runtime support files would be copied into both Chrome and Firefox packages.
They would be loaded only from extension URLs under the extension Content
Security Policy. There would be no CDN import, executable-code download, or
runtime version fallback.

`src/{chrome,firefox}/src/agent/zim-xapian.js` is the license-neutral adapter.
The local worker supplied after approval must expose:

```text
openArchive({ source, record }) -> session
session.hasFullTextIndex() -> boolean
session.searchWithSnippets(query, { limit, language }) -> result[]
session.close()
```

Each result contains `path`, `title`, `snippet`, and optionally `score`. Search
is capped at ten results per archive. A ZIM with no full-text index, a missing
runtime, or a runtime error uses the existing title provider. Reader operations
continue through WebBrain's existing audited ZIM reader.

## Required notices and corresponding source

If GPL distribution is approved, every Chrome and Firefox release must include:

1. the complete GPLv3 and GPLv2 license texts plus all third-party copyright and
   license notices listed above;
2. a prominent notice that the package contains a modified javascript-libzim /
   libzim / Xapian Wasm build and the exact WebBrain modifications and date;
3. the exact build scripts, patches, configuration, interface-definition files,
   and installation information needed to reproduce the shipped Wasm;
4. complete corresponding source for the shipped binaries, published alongside
   the extension release with immutable hashes and a durable retrieval URL;
5. an SBOM mapping every shipped Wasm/JS artifact to its version, source archive,
   license, and SHA-256; and
6. a documented determination about the license of the combined extension and
   any required source release or relicensing of WebBrain itself.

Merely linking to the upstream repositories is not the corresponding-source
procedure for a locally modified binary. Store terms, trademark rules, and the
interaction between browser-extension packaging and GPL linking also require
review before release.

## Owner decision

Exactly one option must be selected in a repository change approved by the
repository owner:

- [ ] **Approve GPL distribution.** The owner accepts the compliance work and
  confirms the repository/release licensing strategy for the combined work.
- [ ] **Reject GPL distribution.** Keep the honest title-only fallback and do
  not claim completion of the issue's Xapian acceptance criterion.
- [ ] **Use a different runtime.** Name a browser-compatible, permissively
  licensed implementation that can query the ZIM Xapian index; repeat this
  dependency and distribution review before bundling it.

Approver: _pending_  
Decision date: _pending_  
Decision/reference: _pending_

Until those fields are completed, `ZIM_XAPIAN_RUNTIME_BUNDLED` remains `false`
and `ZIM_XAPIAN_DISTRIBUTION_STATUS` remains
`blocked-pending-owner-license-decision` in both browser implementations.
