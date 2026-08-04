#!/usr/bin/env bash
set -euo pipefail

model_path="${DEEPSEEK_VISION_MODEL_PATH:-webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4}"
model_revision="${DEEPSEEK_VISION_REVISION:-}"
tensor_parallel_size="${DEEPSEEK_VISION_TP:-5}"
context_length="${DEEPSEEK_VISION_CONTEXT_LENGTH:-4096}"
mem_fraction_static="${DEEPSEEK_VISION_MEM_FRACTION_STATIC:-0.92}"
host="${DEEPSEEK_VISION_HOST:-127.0.0.1}"
port="${DEEPSEEK_VISION_PORT:-30000}"
model_python_path="${DEEPSEEK_VISION_PYTHONPATH:-}"

if [[ -z "$model_python_path" ]]; then
  echo "Set DEEPSEEK_VISION_PYTHONPATH to MODEL_DIR/sglang_ext." >&2
  exit 2
fi

export PYTHONPATH="${model_python_path}${PYTHONPATH:+:${PYTHONPATH}}"
export SGLANG_EXTERNAL_MODEL_PACKAGE="deepseek_vision_sglang.models"
export SGLANG_EXTERNAL_MM_MODEL_ARCH="DeepseekV4ForCausalLM"
export SGLANG_EXTERNAL_MM_PROCESSOR_PACKAGE="deepseek_vision_sglang.processors"

python -m deepseek_vision_sglang.patch --apply

launch_args=(
  --model-path "$model_path"
  --tp-size "$tensor_parallel_size"
  --context-length "$context_length"
  --mem-fraction-static "$mem_fraction_static"
  --host "$host"
  --port "$port"
  --trust-remote-code
  --enable-multimodal
  --limit-mm-data-per-request '{"image":1}'
  # Native NVFP4 kernels require Blackwell. SGLang v0.5.16 supports the
  # Marlin W4A16 fallback for dense and MoE layers on SM80-SM90 GPUs
  # (A100, Ada/L40S, H100, and H200).
  --fp4-gemm-backend marlin
  --moe-runner-backend marlin
  --disable-cuda-graph
  --skip-server-warmup
)
if [[ -n "$model_revision" ]]; then
  launch_args+=(--revision "$model_revision")
fi

exec python -m sglang.launch_server "${launch_args[@]}"
