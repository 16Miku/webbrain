| Model | Protocol | API responses | Parsed calls | Exact ideal | Ideal tool name | Sonnet tool-name alignment | Median | Reported cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Nex-N2.5-Pro | frozen-native | 100/100 | 95/100 | 11/100 | 27/100 | 67.0% | 7.23s | $0.14999 |
| Nex-N2.5-mini | frozen-native | 0/100 | 0/100 | N/A | N/A | N/A | N/A | N/A |
| MiniMax M3 (historical) | frozen-native | 100/100 | 85/100 | 17/100 | 32/100 | 75.0% | 3.10s | $1.05621 |
| Nex-N2-mini (historical) | frozen-native | 100/100 | 93/100 | 16/100 | 28/100 | 65.0% | 2.23s | $0.04550 |
| Qwen 3.8 27B (historical) | compact-native | 100/100 | 99/100 | 15/100 | 38/100 | N/A | 2.07s | $0.20945 |
| Nex-N2.5-mini fallback smoke | frozen-text-fallback-smoke | 0/3 | 0/3 | N/A | N/A | N/A | N/A | N/A |

- Only first model turns are captured. No browser tools are executed; this is not end-to-end task success or a vision benchmark.
- Strict exact ideal: tool name plus deep-equal arguments. Ideal tool name ignores arguments. Prose receives no ideal-tool credit.
- Sonnet alignment compares tool names, including agreement on no tool. It is reference agreement, not correctness.
- All frozen-native rows pin the May 23 system prompt and 41 tools. User context and site adapters are assembled by the runner; old requests were not saved, so historical payload byte equality is unverified.
- Qwen 3.8 27B is the saved September 5 compact run. It is contextual only and cannot be ranked against frozen rows.
- Frozen ideal scores use May 23 goldens archived from commit 0bbaf627ec2637898b587d5a7e5895f318f25bab, reproducing historical MiniMax M3 scores (17 exact / 32 ideal names). Qwen uses a separate captured compact rubric snapshot; these protocols cannot be ranked together.
- The mini native endpoint rejected all 100 requests before inference. Its performance and cost are N/A, not a 0% intelligence score or free inference.
- Fallback smoke folds system instructions into user text, lists tool names and requests textual tool calls. It omits structured schemas and is not the native frozen benchmark.
- Latency and reported usage cost are route- and date-specific; native runs use concurrency 2, historical Nex-N2-mini used 3, fallback smoke uses 1.
- No reasoning effort override, seed, top_p, or top_k was sent. Native temperature is 0.15 for action modes or 0.3 for ask, max_tokens 4096.
