#!/usr/bin/env bash
set -euo pipefail

required_gpus="${DEEPSEEK_VISION_REQUIRED_GPUS:-8}"
required_disk_gib="${DEEPSEEK_VISION_REQUIRED_DISK_GIB:-1000}"

command -v nvidia-smi >/dev/null || { echo "FAIL: nvidia-smi not found"; exit 1; }
gpu_count="$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l | tr -d ' ')"
if [[ "$gpu_count" -lt "$required_gpus" ]]; then
  echo "FAIL: found $gpu_count GPUs; need at least $required_gpus"
  exit 1
fi

echo "GPU inventory"
nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv
echo
echo "GPU topology"
nvidia-smi topo -m

available_kib="$(df -Pk . | awk 'NR==2 {print $4}')"
available_gib="$((available_kib / 1024 / 1024))"
if [[ "$available_gib" -lt "$required_disk_gib" ]]; then
  echo "FAIL: ${available_gib} GiB free; need at least ${required_disk_gib} GiB"
  exit 1
fi
echo "PASS: $gpu_count GPUs and ${available_gib} GiB free disk"
