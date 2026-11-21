import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The owners portal's own Home Screen app (21/11/2026). Until then every page
// under /portal inherited the root layout's STAFF manifest (start_url "/"), so
// an owner who installed the portal got "ניהול אלמוג" opening the staff login.
// The served HTML (/portal/login → portal.webmanifest, /login → manifest.webmanifest)
// was checked live after the deploy; here: the file and the metadata wiring.

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font', className: 'font' }) }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/components/app-shell/InstallPrompt', () => ({ InstallPrompt: () => null }));

const pub = (f: string) => join(process.cwd(), 'public', f);

interface Manifest {
  id: string; name: string; short_name: string; start_url: string; scope: string;
  display: string; dir: string; lang: string; theme_color: string; icons: { src: string }[];
}

describe('public/portal.webmanifest', () => {
  const m = JSON.parse(readFileSync(pub('portal.webmanifest'), 'utf8')) as Manifest;

  it('is valid JSON that starts and scopes at /portal, standalone, RTL Hebrew, white theme', () => {
    expect([m.id, m.start_url, m.scope, m.display]).toEqual(['/portal', '/portal', '/portal', 'standalone']);
    expect([m.dir, m.lang, m.theme_color]).toEqual(['rtl', 'he', '#FFFFFF']);
    expect(m.short_name).toBe('פורטל אלמוג');
  });
  it('names only icon files that exist, the same ones as the staff manifest', () => {
    const staff = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as Manifest;
    expect(m.icons).toEqual(staff.icons);
    for (const i of m.icons) expect(existsSync(pub(i.src.replace(/^\//, ''))), i.src).toBe(true);
  });
});

describe('which manifest each layout links', () => {
  it('the portal layout links the portal manifest and its own Home Screen title', async () => {
    const { metadata } = await import('@/app/portal/layout');
    expect(metadata.manifest).toBe('/portal.webmanifest');
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: 'פורטל אלמוג' });
    expect(metadata).not.toHaveProperty('icons'); // the root's apple-touch-icon link stays
  });
  it('the root layout (staff pages, /login) still links the staff manifest', async () => {
    const { metadata } = await import('@/app/layout');
    expect(metadata.manifest).toBe('/manifest.webmanifest');
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: 'אלמוג' });
  });
});
