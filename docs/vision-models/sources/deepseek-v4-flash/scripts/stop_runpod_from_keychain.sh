#!/bin/zsh
set -euo pipefail

pod_id="${1:?RunPod pod ID is required}"
keychain_service="${2:-deepseek-vision-runpod}"
case "$pod_id" in
  ''|*[!a-zA-Z0-9_-]*)
    echo "invalid RunPod pod ID" >&2
    exit 2
    ;;
esac

api_key="$(/usr/bin/security find-generic-password -s "$keychain_service" -w)"
trap 'unset api_key' EXIT
{
  printf 'request = "POST"\n'
  printf 'url = "https://rest.runpod.io/v1/pods/%s/stop"\n' "$pod_id"
  printf 'header = "Authorization: Bearer %s"\n' "$api_key"
  printf 'fail\nsilent\nshow-error\n'
} | /usr/bin/curl --config - >/dev/null
