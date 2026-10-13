# HY4, MiMo V2.6, and Liquid LFM2.5

Leave-one-out consensus across all 17 models, comparing the first proposed tool call per response. Recursive object-key sorting only; preserve argument values, defaults, and extra arguments. Additional tool calls are counted separately and not executed or scored. No-tool/no-tool agrees; rejected API requests are excluded from quality. Consensus is agreement, not ground truth.

Only the four October 14 planner models and two MiMo vision runs are new. Historical requests were omitted and are reconstructed from pinned source; full historical body equality is unprovable. Serving dates, provider routes, caches and bills differ. No browser tools are executed.

| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash 0731 | 50.9% | 79.6% | 90 / 90 | 39 | 18 | 1.58s | 5.24s | $0.0504 |
| Tencent HY3 | 47.4% | 77.8% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.2459 |
| MiMo-V2.6-Pro | 43.6% | 78.6% | 95 / 95 | 44 | 16 | 6.12s | 46.68s | $0.1246 |
| GLM-5.2 | 42.8% | 75.9% | 86 / 89 | 39 | 20 | 1.73s | 4.44s | $0.5452 |
| MiMo-V2.6-Flash | 41.9% | 73.0% | 96 / 97 | 37 | 17 | 1.20s | 4.26s | $0.0110 |
| MiniMax M3 | 40.6% | 74.6% | 86 / 89 | 33 | 17 | 2.86s | 7.34s | $0.5038 |
| Poolside Laguna XS 2.1 | 39.6% | 73.2% | 88 / 89 | 31 | 5 | 1.15s | 2.15s | $0.0729 |
| Tencent HY4 Preview | 27.5% | 78.6% | 98 / 98 | 36 | 16 | 5.81s | 11.64s | $0.2961 |
| Liquid LFM2.5-24B-A2B | 24.9% | 68.2% | 94 / 95 | 23 | 6 | 1.83s | 6.68s | $0.0829 |

## Vision

| Model | Passes / 100 | Mean rubric | Median | p95 | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| MiMo-V2.6-Flash | 81 | 94.3% | 1.91s | 4.59s | $0.0214 |
| Qwen3.8 Flash | 79 | 94.8% | 8.49s | 13.43s | $0.0411 |
| MiMo-V2.6-Pro | 77 | 94.0% | 5.73s | 11.59s | $0.0645 |
| GLM-5.3 Flash | 76 | 93.8% | 5.49s | 8.92s | $0.0211 |
