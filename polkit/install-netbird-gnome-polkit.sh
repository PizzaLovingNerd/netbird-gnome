#!/bin/bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "This installer must be run as root (for example via pkexec)." >&2
    exit 1
fi

EXTENSION_DIR="${1:-}"
if [[ -z "${EXTENSION_DIR}" || ! -d "${EXTENSION_DIR}/polkit" ]]; then
    echo "Usage: install-netbird-gnome-polkit.sh <path-to-netbird-gnome-extension>" >&2
    exit 1
fi

POLICY_SRC="${EXTENSION_DIR}/polkit/io.netbird.gnome.policy"
HELPER_SRC="${EXTENSION_DIR}/polkit/netbird-gnome-config-write"
POLICY_DEST="/usr/share/polkit-1/actions/io.netbird.gnome.policy"
HELPER_DEST="/usr/libexec/netbird-gnome-config-write"

[[ -f "${POLICY_SRC}" ]] || { echo "Missing policy file: ${POLICY_SRC}" >&2; exit 1; }
[[ -f "${HELPER_SRC}" ]] || { echo "Missing helper script: ${HELPER_SRC}" >&2; exit 1; }

install -Dm644 "${POLICY_SRC}" "${POLICY_DEST}"
install -Dm755 "${HELPER_SRC}" "${HELPER_DEST}"

echo "Installed NetBird GNOME PolicyKit files:"
echo "  ${POLICY_DEST}"
echo "  ${HELPER_DEST}"
