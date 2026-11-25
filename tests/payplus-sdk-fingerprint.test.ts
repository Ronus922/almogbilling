import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The PayPlus browser SDK runs on the payment page, next to the card fields.
// The exact bundle that was read and reviewed (25/11/2026) is pinned here by
// its SHA-256: package.json pins the version, and this pins the bytes.
//
// WHEN THIS FAILS — a dependency update changed the SDK. Do not just replace
// the hash. Read what changed in the new bundle (its source map holds the
// readable sources: dist/payplus-hosted-fields.min.js.map), re-check the two
// things src/components/chip-order/PayPlusCardFields.tsx leans on — the
// window "message" listener registered in the constructor, and the
// "secure-3ds" branch that appends a frame — walk the payment step in a
// browser against the PayPlus sandbox, and only then put the new values here.
const REVIEWED = {
  version: '1.5.0',
  sha256: 'ec835183b6c6fa0adc42a2c297ba0cac75c7bf94697517e205654a313ffa1451',
};

const pkgDir = path.join(process.cwd(), 'node_modules', 'payplus-hosted-fields');

describe('payplus-hosted-fields — the reviewed bundle', () => {
  it(`is version ${REVIEWED.version}, pinned exactly in package.json`, () => {
    const installed = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    expect(installed.version).toBe(REVIEWED.version);
    const ours = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(ours.dependencies['payplus-hosted-fields']).toBe(REVIEWED.version); // no ^ and no ~
  });

  it('is byte for byte the bundle that was reviewed', () => {
    const bundle = readFileSync(path.join(pkgDir, 'dist', 'payplus-hosted-fields.min.js'));
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(REVIEWED.sha256);
  });
});
