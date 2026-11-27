# tests/helpers/argv-recorder.sh — the fake git / psql / pg_dump / curl / docker /
# sudo / restic of tests/no-secrets-on-argv.test.ts (one file, a symlink per
# tool name). Arguments go to $SHIM_ARGV_LOG (one line per call, separated by
# \x1f); what a tool got on stdin to $SHIM_STDIN_LOG; facts about its
# environment to $SHIM_ENV_LOG. git runs the real one ($REAL_GIT) after logging.
name="$(basename "$0")"
{ printf '%s' "$name"; for a in "$@"; do printf '\x1f%s' "${a//$'\n'/\\n}"; done; printf '\n'; } >> "$SHIM_ARGV_LOG"
case "$name" in
  git) exec "$REAL_GIT" "$@" ;;
  psql|pg_dump)
    if [[ -n "${PGPASSWORD-}" && "${PGPASSWORD}" == "${SHIM_EXPECT_PGPASSWORD-}" ]]; then echo "$name PGPASSWORD=expected" >> "$SHIM_ENV_LOG"
    else echo "$name PGPASSWORD=other" >> "$SHIM_ENV_LOG"; fi
    cat > /dev/null
    if [[ "${SHIM_PSQL:-ok}" == fail ]]; then echo "psql: error: connection to server failed" >&2; exit 2; fi
    if [[ "$name" == pg_dump ]]; then echo '-- fake dump'; else printf '%s\n' "${SHIM_PSQL_OUT:-}"; fi ;;
  curl)
    input="$(cat)"
    printf '%s\n\x1e\n' "$input" >> "$SHIM_STDIN_LOG"
    if [[ -n "${SHIM_CURL_FAIL_ON:-}" && "$input" == *"$SHIM_CURL_FAIL_ON"* ]]; then exit 22; fi
    printf '{"ok":true}\n200' ;;
  sudo)
    if [[ "$*" == "-n cat /etc/billing/billing.env" ]]; then exec cat "$SHIM_FAKE_BILLING_ENV"; fi
    if [[ "$1" == grep && "${!#}" == /etc/billing/billing.env ]]; then shift; exec grep "${@:1:$#-1}" "$SHIM_FAKE_BILLING_ENV"; fi
    exit 1 ;;
  docker)
    case "$1" in
      inspect|rm) exit 0 ;;
      logs) echo 'PostgreSQL init process complete; ready for start up.' ;;
      run) printf 'docker-run POSTGRES_PASSWORD=%s\n' "${POSTGRES_PASSWORD-}" >> "$SHIM_ENV_LOG"; echo fakecontainer ;;
      exec)
        cat > /dev/null
        if [[ " $* " == *" pg_dump"* ]]; then for i in $(seq 1 200); do echo "-- fake dump line $i"; done
        elif [[ "$*" == *"select 1"* ]]; then echo 1
        elif [[ "$*" == *"count(*)"* ]]; then echo 5
        fi ;;
    esac ;;
  restic) [[ "$1 $2" == "cat config" ]] && exit 0; echo "restic: fake failure" >&2; exit 1 ;;
esac
exit 0
