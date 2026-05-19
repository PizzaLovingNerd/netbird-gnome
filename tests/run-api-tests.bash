#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

chmod +x tests/mock-netbird.bash
gjs -m tests/api.test.js
