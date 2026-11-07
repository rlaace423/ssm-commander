#!/bin/sh
# Shows a prompt, "types" each command line, then runs it through the demo launcher.
# usage: shell.sh "<command line>"...   Each line starts with "ssm-commander". Used only by demo/record.exp.
export TERM=xterm-256color COLORTERM=truecolor # colors are decided from TERM
for line in "$@"; do
  printf '$ '
  i=1
  while [ "$i" -le "${#line}" ]; do
    printf '%s' "$line" | cut -c "$i" | tr -d '\n'
    sleep 0.05
    i=$((i + 1))
  done
  sleep 0.5
  printf '\n'
  # shellcheck disable=SC2086 # the command line is split into words on purpose
  node demo/run.mjs ${line#ssm-commander}
done
printf '$ '
sleep 1.5
