# Source and evidence appendix

This appendix contains small, auditable inputs needed to understand or reproduce the two
vision-adapter experiments. It intentionally excludes model weights, optimizer tensors,
dataset images, API tokens, SSH material, caches, and virtual environments.

## Layout

- `deepseek-v4-flash/`: a curated snapshot of the local DeepSeek implementation, including
  configs, training/inference code, SGLang extension code, scripts, tests, and design notes.
- `laguna-xs-2.1/private-training-archive/`: the Laguna private Hugging Face archive's
  README, training log, final run summary/state, archive SHA list, and the two code snapshots
  stored with the run.
- `published-artifacts/`: copies of the public model cards and machine-readable adapter
  manifests at the revisions listed in `ARTIFACTS.json`.
- `SOURCE_SNAPSHOT.json`: provenance and caveats for the copied local source.
- `ARTIFACTS.json`: compact final repository/component manifest.
- `SHA256SUMS`: hashes for every file in this appendix except `SHA256SUMS` itself.

## Source snapshot caveat

The local DeepSeek project was not a clean Git checkout when this appendix was created. Its
base commit was `285a35a1c5cbff3251418013a0671b25ef78488a`, with modified training/guard files and
uncommitted serving, inference, SGLang, and test additions. The snapshot is therefore
described as **base commit plus working-tree changes**, not as the contents of that commit.
The exact dirty-file inventory is in `SOURCE_SNAPSHOT.json`.

The five packaged SGLang runtime/documentation files and three focused regression tests
listed in `SOURCE_SNAPSHOT.json` were later synchronized byte-for-byte from the final
public DeepSeek NVFP4 revision. That bounded sync does not turn the rest of the historical
snapshot into a clean public-package checkout.

This distinction matters because the local README contains a historical sentence saying
the 100K run had not started, while the later public model cards and final projectors show
that it subsequently completed. For final artifact status, prefer `ARTIFACTS.json` and the
commit-pinned Hugging Face pages.

## Laguna archive caveat

The copied Laguna `run-summary.json` describes the resumed process only. Training had first
reached step 384, then restarted from the last durable step-380 checkpoint. Consequently,
the final summary's `examples` field is cumulative, while its `elapsed_seconds`,
`examples_per_hour`, and first/minimum loss fields cover only the resumed segment. See the
runbook for the correct interpretation.

## Verify the appendix

From this directory:

```bash
shasum -a 256 -c SHA256SUMS
```

To verify a large Hugging Face artifact, download the exact revision into external storage
and compare its SHA-256 with `ARTIFACTS.json`. Do not place multi-gigabyte weights in this
documentation tree.
