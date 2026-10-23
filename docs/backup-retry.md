# Off-site backup retry / catch-up

A night without outbound access to Backblaze B2 must not be a night without an off-site
backup (22→23/10/2026: the uplink to B2 was down from ~02:30 UTC and all three off-site
backups failed). `deploy/backup-retry/` keeps the server-side mechanism in git.

| File | Installed as |
|---|---|
| `backup-retry.sh` | `/usr/local/bin/backup-retry.sh` (755 root) |
| `backup-catchup.sh` | `/usr/local/bin/backup-catchup.sh` |
| `backup-verify-restic.sh` | `/usr/local/bin/backup-verify-restic.sh` |
| `jobs.d/restic-push.conf` | `/etc/backup-retry/jobs.d/restic-push.conf` (644, no secrets) |
| `systemd/backup-retry@.service`, `backup-catchup.service`, `backup-catchup.timer` | `/etc/systemd/system/` |
| `systemd/billing-backup.service.d-backup-retry.conf` | `/etc/systemd/system/billing-backup.service.d/backup-retry.conf` |

Also needed once: `install -d -m 2775 -o root -g ubuntu /var/lib/backup-status`, then
`systemctl daemon-reload && systemctl enable --now backup-catchup.timer`.

## How it works

- `billing-backup.service` runs `pg-backup.sh` (local, needs no network) and then
  `backup-retry.sh run restic-push` instead of `restic-push.sh` directly.
- The wrapper takes `flock -n /var/lock/<job>.lock`, checks the uplink before **every**
  attempt (no uplink = the backup is not started), and backs off 1, 2, 5, 10, 15 min, then
  every 15 min, for at most 4 h.
- Success = the command exits 0 **and** `backup-verify-restic.sh supabase-daily storage`
  finds both snapshots dated today. Only then `/var/lib/backup-status/<job>.last-success`
  gets today's date and the healthchecks success ping is sent.
- `backup-catchup.timer` fires hourly 04:00–12:00 (host time, UTC). Any job whose
  `last-success` is not today is started again. At 12:00 a job still without success gets
  one healthchecks `/fail` ping. Nothing is pinged `/fail` per attempt (`restic-push.sh`
  stays silent under the wrapper: `BACKUP_RETRY_WRAPPED=1`).

## restic-push.sh and `restic init`

`restic cat config` failing proves nothing: restic 0.16 prints "Is there a repository at
the following location?" for any failure to read the config object (timeout, DNS, 401), and
exit code 10 for a missing repo only exists from 0.17. The script therefore **refuses** to
`init` on a read error. `init` runs only with `RESTIC_ALLOW_INIT=1` (a genuinely new
repository) and an error that names a missing object without a network/auth symptom.

## Manual checks

```bash
cat /var/lib/backup-status/restic-push.last-success       # today's date = done
journalctl -u billing-backup -u backup-retry@restic-push -n 50
sudo systemctl start backup-retry@restic-push.service      # run a window now
```
