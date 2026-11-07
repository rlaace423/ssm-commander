#!/bin/sh
# Re-records demo/connect.gif. Needs expect (ships with macOS), asciinema and agg (brew install asciinema agg).
set -eu
cd "$(dirname "$0")/.."
node demo/build.mjs
expect demo/record.exp demo/build/connect.cast demo/build/demo.mjs
agg --cols 130 --rows 20 --font-size 14 --theme github-dark --idle-time-limit 4 --last-frame-duration 2 \
  demo/build/connect.cast demo/connect.gif
ls -la demo/connect.gif
