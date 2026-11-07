#!/bin/sh
# Shows a prompt, "types" the command, then runs the demo bundle. Used only inside demo/record.exp.
demo="$1"
# Colors are decided from TERM; the recording pty would otherwise look like a dumb terminal.
export TERM=xterm-256color COLORTERM=truecolor
printf '$ '
for ch in s s m - c o m m a n d e r; do
  printf '%s' "$ch"
  sleep 0.07
done
sleep 0.5
printf '\n'
node "$demo"
printf '$ '
sleep 1.5
