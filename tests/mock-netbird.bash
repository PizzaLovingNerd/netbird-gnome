#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  up)
    echo "Daemon status: Connected"
    ;;
  down)
    echo "Disconnected"
    ;;
  status)
    echo '{"daemonStatus":"Connected"}'
    ;;
  profile)
    case "${2:-}" in
      list)
        echo "Found 2 profiles:"
        echo "* default"
        echo "- work"
        ;;
      add)
        echo "Profile added successfully: ${3:-}"
        ;;
      remove)
        echo "Profile removed successfully: ${3:-}"
        ;;
      select)
        echo "Profile switched successfully to: ${3:-}"
        ;;
      *)
        echo "unsupported profile command: ${2:-}" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "unsupported command: ${1:-}" >&2
    exit 2
    ;;
esac
