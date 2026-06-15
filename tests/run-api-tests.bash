#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

gjs -m tests/api.test.js
