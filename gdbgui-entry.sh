#!/bin/sh

pip install -r /app/requirements.txt
pip install -e /app || true

# Clean uploads directory at startup
echo "[gdbgui] Cleaning gdbgui_uploads volume at startup..."
echo "Before cleanup:"
ls -la /app/gdbgui/server/uploads/ 2>/dev/null || echo "Directory not found or empty"
rm -rf /app/gdbgui/server/uploads/*
echo "After cleanup:"
ls -la /app/gdbgui/server/uploads/ 2>/dev/null || echo "Directory not found or empty"
echo "[gdbgui] Startup cleanup done."

python -m gdbgui --host="0.0.0.0" --port="5000" &
PID=$!

cleanup() {
    echo "[gdbgui] Cleaning gdbgui_uploads volume..."
    echo "Before cleanup on stop:"
    ls -la /app/gdbgui/server/uploads/ 2>/dev/null || echo "Directory not found or empty"
    rm -rf /app/gdbgui/server/uploads/*
    echo "After cleanup on stop:"
    ls -la /app/gdbgui/server/uploads/ 2>/dev/null || echo "Directory not found or empty"
    echo "[gdbgui] Cleanup done."
    kill $PID
}

trap 'cleanup' TERM

wait $PID
