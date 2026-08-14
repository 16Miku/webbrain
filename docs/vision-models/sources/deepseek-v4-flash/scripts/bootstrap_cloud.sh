#!/usr/bin/env bash
set -euo pipefail

project_dir="${DEEPSEEK_VISION_PROJECT_DIR:-$PWD}"
mkdir -p "$project_dir/artifacts"
venv_args=()
if [[ "${DEEPSEEK_VISION_SYSTEM_SITE_PACKAGES:-0}" == "1" ]]; then
  venv_args+=(--system-site-packages)
fi
python3 -m venv "${venv_args[@]}" "$project_dir/.venv"
"$project_dir/.venv/bin/python" -m pip install --upgrade pip wheel
torch_index_url="${DEEPSEEK_VISION_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
"$project_dir/.venv/bin/python" -m pip install \
  'torch==2.11.0' \
  'torchvision==0.26.0' \
  'torchaudio==2.11.0' \
  --index-url "$torch_index_url"
"$project_dir/.venv/bin/python" -m pip install -e "$project_dir[train]"
"$project_dir/.venv/bin/python" -m pip check
"$project_dir/.venv/bin/python" -m pip freeze > "$project_dir/artifacts/environment.lock.txt"
