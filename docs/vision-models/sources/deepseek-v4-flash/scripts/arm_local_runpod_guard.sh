#!/bin/zsh
set -euo pipefail

pod_id="${1:?RunPod pod ID is required}"
cap_deadline_epoch="${2:?Absolute budget-cap deadline epoch is required}"
keychain_service="${3:-deepseek-vision-runpod}"
ssh_identity="${4:-$HOME/.ssh/id_ed25519-runbod}"
label="${5:-com.openai.deepseek-vision.runpod-stop-guard}"
guard_script="${0:A:h}/runpod_verified_work_guard.sh"
stop_script="${0:A:h}/stop_runpod_from_keychain.sh"
install_dir="${CODEX_RUNPOD_GUARD_DIR:-$HOME/.codex/runpod-guards/deepseek-vision}"

if [[ ! -x "$guard_script" || ! -x "$stop_script" ]]; then
  echo "guard and stop scripts must both be executable" >&2
  exit 2
fi

# macOS background launch jobs do not inherit Codex's security-scoped access to
# Documents. Install secret-free script copies under ~/.codex so launchd can
# execute them; the API key remains in Keychain and is fetched only at runtime.
/bin/mkdir -p "$install_dir"
/usr/bin/install -m 700 "$guard_script" "$install_dir/runpod_verified_work_guard.sh"
/usr/bin/install -m 700 "$stop_script" "$install_dir/stop_runpod_from_keychain.sh"
installed_guard="$install_dir/runpod_verified_work_guard.sh"

/bin/launchctl remove "$label" >/dev/null 2>&1 || true
/bin/launchctl submit -l "$label" -- \
  /bin/zsh "$installed_guard" "$pod_id" "$cap_deadline_epoch" "$keychain_service" "$ssh_identity" 1800
echo "Armed verified-work RunPod guard through epoch $cap_deadline_epoch."
