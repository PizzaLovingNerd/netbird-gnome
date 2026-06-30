#!/usr/bin/env bash
set -euo pipefail

shell_major="$(gnome-shell --version | awk '{print int($3)}')"

if ((shell_major >= 49)); then
    exec dbus-run-session -- gnome-shell --devkit --wayland
fi

exec dbus-run-session -- gnome-shell --nested --wayland
