#!/usr/bin/env bash
# register_playbook.sh: create (or update) the Devin Farm playbook in a Devin org.
#   Create: POST /v3/organizations/{org_id}/playbooks
#   Update: PUT  /v3/organizations/{org_id}/playbooks/{playbook_id}   (when FARM_PLAYBOOK_ID is set)
# Body: {title, body: SKILL.md, macro: "!farm", structured_output_schema: claim.schema.json}.
# Needs DEVIN_API_KEY (needs ManageOrgPlaybooks) and DEVIN_ORG_ID. Prints only the playbook id
# and an export line. Note: Devin marks playbooks deprecated; on orgs migrated to Skills
# these calls write a skill instead, and the returned id still works as playbook_id.
set -euo pipefail

die() { echo "register_playbook: $*" >&2; exit 1; }

[ -n "${DEVIN_API_KEY:-}" ] || die "DEVIN_API_KEY is not set"
[ -n "${DEVIN_ORG_ID:-}" ] || die "DEVIN_ORG_ID is not set"
for dep in curl jq; do command -v "$dep" >/dev/null 2>&1 || die "missing dependency: $dep"; done

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
API="${DEVIN_API_BASE:-https://api.devin.ai}"
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/playbook.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT

jq -n --rawfile body "$DIR/SKILL.md" --slurpfile schema "$DIR/claim.schema.json" \
  '{title: "Devin Farm: hardware lease + verify", body: $body, macro: "!farm", structured_output_schema: $schema[0]}' \
  >"$TMPD/req.json"

if [ -n "${FARM_PLAYBOOK_ID:-}" ]; then
  method=PUT
  url="$API/v3/organizations/$DEVIN_ORG_ID/playbooks/$FARM_PLAYBOOK_ID"
else
  method=POST
  url="$API/v3/organizations/$DEVIN_ORG_ID/playbooks"
fi

# The key goes to curl on stdin (config), never on the command line.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$DEVIN_API_KEY" |
  curl -sS -K - -X "$method" -m 30 -H 'Content-Type: application/json' \
    --data-binary "@$TMPD/req.json" -o "$TMPD/resp.json" -w '%{http_code}' "$url") ||
  die "request to $url failed"

case "$code" in
  2??) ;;
  *)
    detail=$(jq -r '.detail // .title // empty | tostring' "$TMPD/resp.json" 2>/dev/null || true)
    echo "register_playbook: $method $url -> HTTP $code${detail:+: $detail}" >&2
    if [ "$code" = 409 ] && [ "$method" = POST ]; then
      echo "register_playbook: a playbook with macro !farm may already exist; set FARM_PLAYBOOK_ID to update it" >&2
    fi
    exit 1
    ;;
esac

id=$(jq -r '.playbook_id // empty' "$TMPD/resp.json")
[ -n "$id" ] || die "response has no playbook_id"
echo "$id"
echo "export FARM_PLAYBOOK_ID=$id"
