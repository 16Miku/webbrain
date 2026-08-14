#!/usr/bin/env bash
set -euo pipefail

project_dir="${DEEPSEEK_VISION_PROJECT_DIR:-$PWD}"
venv_dir="$project_dir/.venv-moonvit"
python3 -m venv --system-site-packages "$venv_dir"
"$venv_dir/bin/python" -m pip install --upgrade pip wheel
"$venv_dir/bin/python" -m pip install \
  'transformers>=4.57.1,<5.0.0' \
  'huggingface-hub>=0.34,<1.0' \
  'safetensors>=0.5' \
  'pillow>=11' \
  'pydantic>=2.11,<3' \
  'tiktoken>=0.9'
MAX_JOBS="${MAX_JOBS:-16}" "$venv_dir/bin/python" -m pip install \
  'flash-attn==2.8.3.post1' --no-build-isolation
"$venv_dir/bin/python" -m pip install --no-deps -e "$project_dir"
mkdir -p "$project_dir/artifacts"
"$venv_dir/bin/python" -m pip freeze > "$project_dir/artifacts/moonvit-environment.lock.txt"
