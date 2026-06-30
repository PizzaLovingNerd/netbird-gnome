#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="${root_dir}/dist"

mkdir -p "${output_dir}"

sources=(
    api
    extensionErrors.js
    gtkProfileDialogs.js
    icons
    LICENSE
    networks-window.js
    profileState.js
    settings-window-ui.js
    settings-window.js
    settings.js
    settingsManager.js
    shellProfileDialog.js
    windowIcon.js
)

extra_sources=()
for source in "${sources[@]}"; do
    extra_sources+=("--extra-source=${source}")
done

cd "${root_dir}"
gnome-extensions pack \
    --force \
    --out-dir="${output_dir}" \
    "${extra_sources[@]}" \
    .

archive="${output_dir}/gnome@netbird.io.shell-extension.zip"
unzip -t "${archive}"
printf 'Created %s\n' "${archive}"
