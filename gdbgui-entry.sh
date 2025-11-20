#!/bin/sh

pip install -r /app/requirements.txt || pip install -e /app || true || python -m gdbgui --host="0.0.0.0" --port="5000"
