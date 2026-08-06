#!/usr/bin/env bash
set -euo pipefail

model_path="${DEEPSEEK_VISION_MODEL_PATH:-webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4}"
model_revision="${DEEPSEEK_VISION_REVISION:-}"
tensor_parallel_size="${DEEPSEEK_VISION_TP:-4}"
context_length="${DEEPSEEK_VISION_CONTEXT_LENGTH:-4096}"
mem_fraction_static="${DEEPSEEK_VISION_MEM_FRACTION_STATIC:-0.85}"
host="${DEEPSEEK_VISION_HOST:-127.0.0.1}"
port="${DEEPSEEK_VISION_PORT:-30000}"
model_python_path="${DEEPSEEK_VISION_PYTHONPATH:-}"
kernel_profile="${DEEPSEEK_VISION_KERNEL_PROFILE:-blackwell-native}"

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
  --disable-cuda-graph
  --skip-server-warmup
)
case "$kernel_profile" in
  blackwell-native)
    # Verified loader/startup profile for lmsysorg/sglang:deepseek-v4-blackwell
    # on B200. flashinfer-python 0.6.14 currently pairs with the available
    # flashinfer-cubin 0.6.13 wheel, so the upstream version check is disabled.
    export FLASHINFER_DISABLE_VERSION_CHECK="${FLASHINFER_DISABLE_VERSION_CHECK:-1}"
    blackwell_ld_prefix="/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib:/usr/local/lib/python3.12/dist-packages/torch/lib:/usr/local/lib/python3.12/dist-packages/tvm_ffi/lib:/usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
    export LD_LIBRARY_PATH="${blackwell_ld_prefix}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
    launch_args+=(
      --fp4-gemm-backend flashinfer_trtllm
      --moe-runner-backend flashinfer_trtllm_routed
    )
    ;;
  marlin)
    launch_args+=(--fp4-gemm-backend marlin --moe-runner-backend marlin)
    ;;
  "")
    ;;
  *)
    echo "Unsupported DEEPSEEK_VISION_KERNEL_PROFILE: $kernel_profile" >&2
    exit 2
    ;;
esac
if [[ -n "$model_revision" ]]; then
  launch_args+=(--revision "$model_revision")
fi

exec python -m sglang.launch_server "${launch_args[@]}"
