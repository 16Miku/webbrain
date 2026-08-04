#!/usr/bin/env bash
set -euo pipefail

duration="${1:-4h}"
case "$duration" in
  *m)
    amount="${duration%m}"
    multiplier=60
    ;;
  *h)
    amount="${duration%h}"
    multiplier=3600
    ;;
  *)
    amount="$duration"
    multiplier=3600
    ;;
esac
case "$amount" in
  ''|*[!0-9]*) echo "duration must be a positive integer followed by m or h" >&2; exit 2 ;;
esac
if [[ "$amount" -lt 1 ]]; then
  echo "duration must be at least 1m" >&2
  exit 2
fi
: "${RUNPOD_API_KEY:?RUNPOD_API_KEY is not set by RunPod}"
: "${RUNPOD_POD_ID:?RUNPOD_POD_ID is not set by RunPod}"
command -v setsid >/dev/null 2>&1 || {
  echo "setsid is required to detach the watchdog from SSH" >&2
  exit 2
}

project_dir="${DEEPSEEK_VISION_PROJECT_DIR:-$PWD}"
mkdir -p "$project_dir/artifacts"
pid_file="$project_dir/artifacts/runpod-stop-watchdog.pid"
log_file="$project_dir/artifacts/runpod-stop-watchdog.log"
if [[ -f "$pid_file" ]]; then
  previous_pid="$(<"$pid_file")"
  if [[ "$previous_pid" =~ ^[0-9]+$ ]] && kill -0 "$previous_pid" 2>/dev/null; then
    previous_command="$(ps -p "$previous_pid" -o args=)"
    if [[ "$previous_command" != *'DEEPSEEK_VISION_WATCHDOG_SECONDS'* ]] ||
      [[ "$previous_command" != *'RUNPOD_POD_ID/stop'* ]]; then
      echo "refusing to replace unrelated PID $previous_pid from $pid_file" >&2
      exit 2
    fi
    # setsid makes the watchdog PID its process-group leader; terminate the whole
    # group so the superseded sleep cannot linger after a lease refresh.
    kill -- "-$previous_pid"
  fi
fi
seconds="$((amount * multiplier))"
export DEEPSEEK_VISION_WATCHDOG_SECONDS="$seconds"

nohup setsid bash -c '
  sleep "$DEEPSEEK_VISION_WATCHDOG_SECONDS" &&
  curl --fail --silent --show-error --request POST \
    "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID/stop" \
    --header "Authorization: Bearer $RUNPOD_API_KEY"
' >"$log_file" 2>&1 &
echo "$!" > "$pid_file"
echo "Armed RunPod stop watchdog for $duration (PID $!)."
