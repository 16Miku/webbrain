# DeepSeek V4 Flash Vision and Laguna XS 2.1 Vision

This directory is the reproducibility record for two WebBrain experiments that add a
frozen MoonViT image tower and a trained patch-merger projector to frozen mixture-of-experts
language models.

The record was assembled on 2026-08-04. It distinguishes observed results from planned
experiments and pins every published model repository to the commit that was inspected.
It is a technical report, not a peer-reviewed paper or a claim of benchmark parity with an
upstream multimodal model.

## Document map

- [Research report](research-paper.md): motivation, method, measured results, comparative
  analysis, limitations, and conclusions.
- [Reproducibility runbook](reproducibility.md): exact revisions, commands, checkpoint
  policy, verification gates, publication layout, and recovery notes.
- [Source appendix](sources/README.md): a curated code snapshot, archived run metadata,
  published model cards/manifests, and checksum instructions. No model weights or dataset
  images are duplicated in this Git repository.

## Final model repositories

| Model package | Role | Inspected revision |
|---|---|---|
| [DeepSeek V4 Flash Vision NVFP4](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4) | Complete pinned NVFP4 text package plus MoonViT tower, projector, and custom SGLang source | [`e50f91a535bfad0e6fdd69a9a7920ed8b401cf65`](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4/commit/e50f91a535bfad0e6fdd69a9a7920ed8b401cf65) |
| [DeepSeek V4 Flash Vision BF16](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-BF16) | BF16 vision source overlay; deliberately not a full 291B BF16 text checkpoint | [`fdaec16d9847dc051e2fdcb5287655bf11c80063`](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-BF16/commit/fdaec16d9847dc051e2fdcb5287655bf11c80063) |
| [DeepSeek V4 Flash Vision Training Archive](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-Training-Archive) | Private bring-up, calibration, recovery, and code archive; it predates the completed 100K run | Private, mutable access-controlled repository |
| [Laguna XS 2.1 Vision NVFP4](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-NVFP4) | Complete pinned NVFP4 text package plus MoonViT tower and projector | [`a9d729b41ffbffe4f469c80f498de895a2711aa8`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-NVFP4/commit/a9d729b41ffbffe4f469c80f498de895a2711aa8) |
| [Laguna XS 2.1 Vision BF16](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-BF16) | Complete pinned BF16 text package plus MoonViT tower and projector | [`4d5ca0f788a4e0eeb4e5f8720d82a98008ec8346`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-BF16/commit/4d5ca0f788a4e0eeb4e5f8720d82a98008ec8346) |
| [Laguna XS 2.1 Vision Projector 100K](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-Projector-100K) | Private full projector/optimizer checkpoint history and run evidence | [`4f5d6359867fa55315a2bec4b568901bfdeca5e5`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-Projector-100K/commit/4f5d6359867fa55315a2bec4b568901bfdeca5e5) |

## What is complete

- Both final projectors were trained on 100,000 examples for one epoch and published with
  their frozen BF16 MoonViT towers.
- The DeepSeek adapter preserves the discrete token IDs required by DeepSeek V4's
  hash-routed experts while separately injecting projected image embeddings.
- The Laguna private archive retains the full 782-step projector and optimizer checkpoint
  history, its training log, final state, hashes, and two code snapshots.
- Public NVFP4 and BF16 package layouts, source model revisions, component sizes, and
  component SHA-256 values are recorded in the runbook and artifact manifest.

## What remains incomplete

- No controlled MoonViT-versus-Qwen tower A/B result was completed. The Qwen arm in the
  source tree is an experimental plan, not a reported result.
- No standard vision benchmark suite is archived for either final package, so this report
  does not make quality claims beyond finite training, loss behavior, component integrity,
  and the explicitly listed inference gates.
- Laguna's multimodal processor and serving integration are not packaged, and neither its
  BF16 nor NVFP4 package is an end-to-end image endpoint today.
- DeepSeek's custom SGLang package still requires a pinned source patch and final target-GPU
  validation. It is not stock-SGLang compatible.
- The DeepSeek private archive does not contain a complete final 100K checkpoint history;
  the public final projector is reproducible as an artifact, but the full run telemetry is
  not as complete as Laguna's.

## Reproduction rule

Use commit-pinned URLs and verify hashes before loading any component. A mutable model page
URL is included for convenience, but the commit URL and SHA-256 are the reproducibility
identity. Never infer serving readiness from the presence of model weights alone.
