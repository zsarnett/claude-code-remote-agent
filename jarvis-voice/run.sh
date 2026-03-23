#!/bin/bash
# Launch Jarvis voice assistant
cd "$(dirname "$0")"
source .venv/bin/activate
exec python -m jarvis "$@"
