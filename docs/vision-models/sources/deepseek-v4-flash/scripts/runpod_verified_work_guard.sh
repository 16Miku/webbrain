#!/bin/zsh
set -euo pipefail

pod_id="${1:?RunPod pod ID is required}"
cap_deadline_epoch="${2:?Absolute budget-cap deadline epoch is required}"
keychain_service="${3:-deepseek-vision-runpod}"
ssh_identity="${4:-$HOME/.ssh/id_ed25519-runbod}"
check_interval_seconds="${5:-1800}"

case "$pod_id" in
  ''|*[!a-zA-Z0-9_-]*) echo "invalid RunPod pod ID" >&2; exit 2 ;;
esac
case "$cap_deadline_epoch" in
  ''|*[!0-9]*) echo "cap deadline must be an epoch timestamp" >&2; exit 2 ;;
esac
case "$check_interval_seconds" in
  ''|*[!0-9]*) echo "check interval must be seconds" >&2; exit 2 ;;
esac
if [[ "$check_interval_seconds" -lt 60 || ! -r "$ssh_identity" ]]; then
  echo "check interval must be at least 60 seconds and SSH identity must be readable" >&2
  exit 2
fi

query_pod() {
  local api_key payload response
  api_key="$(/usr/bin/security find-generic-password -s "$keychain_service" -w)"
  payload="{\"query\":\"query GuardPod { pod(input: {podId: \\\"$pod_id\\\"}) { desiredStatus runtime { ports { ip isIpPublic privatePort publicPort type } } } }\"}"
  response="$({
    printf 'url = "https://api.runpod.io/graphql"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$api_key"
    printf 'header = "Content-Type: application/json"\n'
    printf 'silent\nshow-error\nfail\n'
  } | /usr/bin/curl --config - --data-binary "$payload")"
  unset api_key
  printf '%s' "$response"
}

stop_pod() {
  exec "${0:A:h}/stop_runpod_from_keychain.sh" "$pod_id" "$keychain_service"
}

verified_work_is_active() {
  local pod_json host port
  pod_json="$(query_pod)" || return 2
  if [[ "$(printf '%s' "$pod_json" | /usr/bin/jq -r '.data.pod.desiredStatus // "UNKNOWN"')" != "RUNNING" ]]; then
    return 3
  fi
  host="$(printf '%s' "$pod_json" | /usr/bin/jq -r '.data.pod.runtime.ports[]? | select(.isIpPublic == true and .privatePort == 22 and .type == "tcp") | .ip' | /usr/bin/head -1)"
  port="$(printf '%s' "$pod_json" | /usr/bin/jq -r '.data.pod.runtime.ports[]? | select(.isIpPublic == true and .privatePort == 22 and .type == "tcp") | .publicPort' | /usr/bin/head -1)"
  if [[ -z "$host" || -z "$port" || "$port" == "null" ]]; then
    return 2
  fi
  /usr/bin/ssh \
    -i "$ssh_identity" \
    -p "$port" \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o StrictHostKeyChecking=accept-new \
    "root@$host" \
    "pgrep -f '[f]etch_cauldron\\.py|[p]recache_moonvit_images\\.py|[c]ache_moonvit_features\\.py|[s]moke_backward\\.py|[d]eepseek[-_]vision.*(train|training|infer|serve)|[d]eepseek_vision\\.vision_worker|[t]rain_projector' >/dev/null"
}

consecutive_unverified=0
next_check_seconds="$check_interval_seconds"
while true; do
  now="$(date +%s)"
  if [[ "$now" -ge "$cap_deadline_epoch" ]]; then
    stop_pod
  fi
  sleep_for="$next_check_seconds"
  remaining="$((cap_deadline_epoch - now))"
  if [[ "$remaining" -lt "$sleep_for" ]]; then
    sleep_for="$remaining"
  fi
  /bin/sleep "$sleep_for"

  now="$(date +%s)"
  if [[ "$now" -ge "$cap_deadline_epoch" ]]; then
    stop_pod
  fi
  if verified_work_is_active; then
    consecutive_unverified=0
    next_check_seconds="$check_interval_seconds"
    continue
  else
    check_result=$?
  fi
  if [[ "$check_result" -eq 3 ]]; then
    exit 0
  fi

  consecutive_unverified="$((consecutive_unverified + 1))"
  if [[ "$consecutive_unverified" -ge 3 ]]; then
    stop_pod
  fi
  # Do not release expensive GPUs on one transient API or SSH failure. Three
  # consecutive checks still bound an idle pod to roughly ten extra minutes.
  next_check_seconds=300
done
