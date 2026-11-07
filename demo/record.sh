#!/bin/sh
# Re-records the README demos (demo/*.gif). Needs expect (ships with macOS), asciinema and agg
# (brew install asciinema agg). Each scenario's keystrokes are scripted in demo/record.exp.
set -eu
cd "$(dirname "$0")/.."
node demo/build.mjs
DEMO_HOME="$(mktemp -d)"
export DEMO_HOME
trap 'rm -rf "$DEMO_HOME"' EXIT
for scenario in connect forward ssh; do
  expect demo/record.exp "$scenario" "demo/build/$scenario.cast"
  agg --cols 130 --rows 22 --font-size 14 --theme github-dark --idle-time-limit 4 --last-frame-duration 2 \
    "demo/build/$scenario.cast" "demo/$scenario.gif"
done
ls -la demo/*.gif
