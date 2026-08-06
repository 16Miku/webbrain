---
base_model: poolside/Laguna-XS-2.1
base_model_relation: finetune
tags:
- vision-language
- projector
- checkpoints
- laguna
---

# Laguna XS 2.1 Vision Projector - 100K

Private training artifacts for the 100,000-example MoonViT projector run used with `poolside/Laguna-XS-2.1` at revision `e9df9a59996d790b94b70f3fef343fe1d9e34bdf`.

## Run summary

- Examples: 100,000
- Optimizer steps: 782
- World size: 4
- Projector parameters: 30,679,808
- First-step loss: 0.845175
- Final-step loss: 0.731805
- Minimum-step loss: 0.683510
- Throughput: 4,161.27 examples/hour
- Elapsed: 44,432.62 seconds

The final projector is `projector-step-000782.safetensors`. Intermediate projector checkpoints and optimizer states are included for recovery and reproducibility. `SHA256SUMS` covers every uploaded training artifact except this README.

Raw training images and dataset cache files are intentionally excluded.
