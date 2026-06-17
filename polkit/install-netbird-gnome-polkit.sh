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
HELPER_DEST="/var/lib/netbird-gnome/netbird-gnome-config-write"

[[ -f "${POLICY_SRC}" ]] || { echo "Missing policy file: ${POLICY_SRC}" >&2; exit 1; }
[[ -f "${HELPER_SRC}" ]] || { echo "Missing helper script: ${HELPER_SRC}" >&2; exit 1; }

install -Dm755 "${HELPER_SRC}" "${HELPER_DEST}"

if install -Dm644 "${POLICY_SRC}" "${POLICY_DEST}"; then
    echo "Installed NetBird GNOME PolicyKit files:"
    echo "  ${POLICY_DEST}"
else
    cat >&2 <<EOF
Unable to install ${POLICY_DEST}.

The privileged helper was installed, but the PolicyKit action directory is not
writable. This is expected on some atomic/immutable distributions unless the
file is installed by a package or layered into the deployment.

NetBird GNOME will fall back to generic pkexec authentication for config reads
and writes when this policy is unavailable.
EOF
fi

echo "  ${HELPER_DEST}"
