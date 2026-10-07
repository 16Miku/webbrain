| Model | Date | API responses | Native calls | Exact ideal | Ideal name | Sonnet alignment | Median | p95 | Reported cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ling 3.0 Flash VL | 2026-10-05 | 100/100 | 90/100 | 22/100 | 35/100 | 72.0% | 1.73s | 2.91s | $0.00977 |
| Nex-N2.5-Pro | 2026-10-03 | 100/100 | 95/100 | 11/100 | 27/100 | 67.0% | 7.23s | 20.87s | $0.14999 |
| Nex-N2.5-mini | 2026-10-03 | 0/100 | 0/100 | N/A | N/A | N/A | N/A | N/A | N/A |
| MiniMax M3 | 2026-06-21 | 100/100 | 85/100 | 17/100 | 32/100 | 75.0% | 3.10s | 8.20s | $1.05621 |

- First response only, text inputs only, no browser tool execution. These scores are not task completion or vision quality.
- All rows use the May 23 frozen system prompt and 41 tools, plus May 23 ideal goldens archived in the prior Nex report.
- Exact ideal requires deep-equal arguments; ideal name ignores arguments. Neither credits terminal prose. Sonnet alignment measures tool-name agreement including no-tool agreement.
- Historical MiniMax requests were not saved, so per-case message byte equality is unverified. New requests are checked against the payload builder; historical Nex requests retain the frozen system and tools.
- Latency and usage.cost are measured on different dates and provider routes. Provider auto-routing is retained; advertised promotional prices do not guarantee every request uses that provider.
- Nex mini remains unscored: its saved 100-case run and authenticated October 5 route recheck reject structured tools before inference.
- Expired-key attempts were quarantined before the authenticated run and are excluded from these metrics.
