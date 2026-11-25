#!/usr/bin/env bash
# go.sh CMD...: start CMD detached from the ssh session (stdin/stdout/stderr closed) and print its PID, so the
# starting ssh call returns at once and a watcher can `tail --pid` the job.
nohup "$@" > /dev/null 2>&1 < /dev/null &
echo $!
