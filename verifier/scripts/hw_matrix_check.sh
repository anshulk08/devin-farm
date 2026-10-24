#!/usr/bin/env bash
# Hardware check: every image in images/ shown on the Uno Q must PASS against itself and FAIL against
# a different image. Needs the Uno Q (adb) and the webcam; run `farm-verifier calibrate` first.
set -uo pipefail
cd "$(dirname "$0")/.."
fv() { uv run --quiet farm-verifier "$@"; }
verdict() { python3 -c 'import json,sys; r=json.load(sys.stdin)["results"][0]; print(("PASS" if r["passed"] else "FAIL")+"  "+r["detail"])'; }

images=(images/devin-hexes.txt images/cognition-logo.txt images/hex-ring.txt images/prompt.txt images/code-brackets.txt images/dev-text.txt)
bad=0
for i in "${!images[@]}"; do
  img=${images[$i]}
  other=${images[$(( (i + 1) % ${#images[@]} ))]}
  fv show --no-default "$img" >/dev/null || { echo "show failed: $img"; exit 2; }
  sleep 1
  pos=$(fv observe --expect "$img" | verdict)
  neg=$(fv observe --expect "$other" | verdict)
  printf '%-28s shown=self   %s\n%-28s shown=other  %s\n' "$(basename "$img")" "$pos" "" "$neg"
  [[ $pos == PASS* ]] || bad=1
  [[ $neg == FAIL* ]] || bad=1
done
fv show images/devin-hexes.txt >/dev/null  # back to the boot image
[ $bad -eq 0 ] && echo "hw_matrix_check: OK" || echo "hw_matrix_check: FAILED"
exit $bad
