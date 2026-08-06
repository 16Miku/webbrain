#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Project the full A/B bill from a timed run")
    parser.add_argument("run_summary", type=Path)
    parser.add_argument("--node-dollars-per-hour", type=float, required=True)
    parser.add_argument("--arms", type=int, default=2)
    parser.add_argument("--contingency", type=float, default=0.25)
    args = parser.parse_args()
    summary = json.loads(args.run_summary.read_text(encoding="utf-8"))
    examples_per_hour = float(summary["examples_per_hour"])
    per_arm_hours = 100_000 / examples_per_hour
    raw_cost = per_arm_hours * args.node_dollars_per_hour * args.arms
    result = {
        "measured_examples_per_hour": examples_per_hour,
        "projected_hours_per_arm": per_arm_hours,
        "arms": args.arms,
        "raw_cost_usd": raw_cost,
        "cost_with_contingency_usd": raw_cost * (1 + args.contingency),
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
