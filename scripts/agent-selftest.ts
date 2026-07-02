// Self-check for the agent's pure helpers. Run: npx tsx scripts/agent-selftest.ts
// No DB, no network — just asserts the arg mapping + message validation.
import assert from 'node:assert/strict';
import { mapSearchArgs, validateMessages } from '../src/lib/agent/tool';

// mapSearchArgs — query → q (single free-text term; no apt/tab split)
assert.equal(mapSearchArgs({ query: 'כהן' }).q, 'כהן');
assert.equal(mapSearchArgs({ query: '14' }).q, '14', 'numeric query stays one free-text term');
assert.equal(mapSearchArgs({ query: '  דירה 12  ' }).q, 'דירה 12', 'query is trimmed');
assert.equal(mapSearchArgs({}).q, '', 'missing query → empty string');

// status — optional, default undefined (= scan ALL statuses, cross-tab)
assert.equal(mapSearchArgs({}).status, undefined, 'no status → undefined');
assert.equal(mapSearchArgs({ query: 'x' }).status, undefined, 'query without status → undefined');
assert.equal(mapSearchArgs({ status: 'לטיפול משפטי' }).status, 'לטיפול משפטי');
assert.equal(mapSearchArgs({ status: '   ' }).status, undefined, 'blank status → undefined');

// limit clamp
assert.equal(mapSearchArgs({ limit: 999 }).limit, 50, 'over-max clamps to 50');
assert.equal(mapSearchArgs({ limit: 0 }).limit, 1, 'zero clamps to 1');
assert.equal(mapSearchArgs({}).limit, 20, 'default 20');
assert.equal(mapSearchArgs({ limit: 'x' }).limit, 20, 'non-number → default');

// validateMessages
assert.equal(validateMessages([]), null, 'empty → null');
assert.equal(validateMessages('nope'), null, 'non-array → null');
assert.equal(validateMessages([{ role: 'system', content: 'x' }]), null, 'bad role → null');
assert.equal(validateMessages([{ role: 'user', content: '' }]), null, 'empty content → null');
assert.equal(
  validateMessages([{ role: 'assistant', content: 'hi' }]),
  null,
  'must end with a user turn',
);
assert.deepEqual(
  validateMessages([
    { role: 'user', content: 'שלום' },
    { role: 'assistant', content: 'היי' },
    { role: 'user', content: 'מי חייב הכי הרבה?' },
  ]),
  [
    { role: 'user', content: 'שלום' },
    { role: 'assistant', content: 'היי' },
    { role: 'user', content: 'מי חייב הכי הרבה?' },
  ],
);
assert.equal(
  validateMessages([{ role: 'user', content: 'x'.repeat(4001) }]),
  null,
  'over-length content → null',
);

console.log('agent-selftest: all assertions passed ✅');
