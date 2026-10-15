#!/bin/bash
# Scores for the given missions from each shot list's "music" caption and length (gpu.mjs music, ACE-Step through the
# console), with the music service started for the batch and stopped after; writes D:/rtsai-campaign/p2-music-<m>.txt
#   bash tools/briefings/scores.sh epilogue sweet-water ghosts-on-the-glass
set -e
cd "$(dirname "$0")/../.."
node tools/briefings/gpu.mjs service start music
until curl -sf -m 5 -o /dev/null http://localhost:8099/services; do sleep 2; done
for m in "$@"; do
  caption=$(node -e "console.log(require('./tools/briefings/$m.json').music.caption)")
  seconds=$(node -e "console.log(require('./tools/briefings/$m.json').music.seconds ?? 60)")
  for try in 1 2 3 4 5 6 7 8; do
    if out=$(node tools/briefings/gpu.mjs music "$caption" "$seconds" 4); then echo "$out" > "D:/rtsai-campaign/p2-music-$m.txt"; echo "$m: $out"; break; fi
    echo "$m: try $try failed"; sleep 30
  done
done
node tools/briefings/gpu.mjs service stop music
