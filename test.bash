#!/usr/bin/env bash
set -euo pipefail

dbus-run-session -- gnome-shell --nested --wayland
