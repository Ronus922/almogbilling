import { execFile } from 'node:child_process';

// Starting billing's own Bllink scrape from the web process — the ONLY place in
// src/ that runs a child process.
//
// Why a systemd unit and not the scraper itself: Playwright inside the web
// process was rejected on 26/09/2026 (~490MB peak inside billing.service, and a
// deploy restart would kill the scrape mid-flight). The unit already exists for
// the 05:30 timer, already carries OnFailure= (email + WhatsApp) and its own
// 5-minute TimeoutStartSec, so starting IT reuses every guard instead of
// building a second scraping path.
//
// `systemctl start --wait` blocks until the oneshot finishes and exits non-zero
// when the unit failed, which is what lets the route report a real result. Root
// is needed to start a system unit, hence sudo -n with a single least-privilege
// rule (deploy/sudoers.d/billing-bllink-scrape, mirroring billing-deploy):
//
//   ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start --wait billing-bllink-scrape.service
//
// sudo matches the whole argv, so ARGV below and that rule must stay identical.
const SYSTEMCTL = '/usr/bin/systemctl';
const UNIT = 'billing-bllink-scrape.service';
const ARGV = ['-n', SYSTEMCTL, 'start', '--wait', UNIT] as const;

/**
 * Backstop above the unit's own TimeoutStartSec=5min: if systemd itself never
 * returns we still answer the request instead of holding it open forever.
 */
const UNIT_WAIT_TIMEOUT_MS = 330_000;

export type ScrapeUnitResult = { ok: true } | { ok: false; reason: string };

/**
 * Runs one Bllink scrape to completion. Resolves ok:true when the unit finished
 * successfully — which includes the case where the scraper found the advisory
 * lock taken and exited 0 without scraping (see scrapeLock.ts). The caller must
 * therefore verify it got a NEWER snapshot, not merely a successful unit.
 */
export function runScrapeUnit(): Promise<ScrapeUnitResult> {
  return new Promise((resolve) => {
    execFile(
      'sudo',
      [...ARGV],
      { timeout: UNIT_WAIT_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        // systemd's own words are the useful ones ("Job for … failed"); sudo's
        // are what tells us the rule is missing on this host.
        const detail = (stderr || err.message || '').trim().split('\n')[0] ?? '';
        resolve({ ok: false, reason: detail || `systemctl start ${UNIT} failed` });
      },
    );
  });
}
