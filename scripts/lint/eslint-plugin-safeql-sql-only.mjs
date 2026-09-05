/**
 * `safeql-sql-only/check-sql` — SafeQL's check-sql rule with the type-annotation
 * reports filtered out (missing / incorrect / invalid type annotation).
 *
 * Why: SafeQL compares `queryOne<UserRow>(…)` against the type it infers for the
 * result set. This codebase deliberately types rows with hand-written
 * interfaces (Date for timestamptz, wider nullability, narrowed enums), so that
 * comparison produces dozens of non-bugs. What we want from SafeQL in this
 * phase is SQL validity against the live schema: unknown table/column, syntax,
 * parameter count. Everything else the rule reports passes through untouched.
 */
import * as safeql from '@ts-safeql/eslint-plugin';

const TYPE_ANNOTATION_MESSAGES = new Set([
  'missingTypeAnnotations',
  'incorrectTypeAnnotations',
  'invalidTypeAnnotations',
]);

const base = safeql.rules['check-sql'];

const checkSqlOnly = {
  ...base,
  meta: {
    ...base.meta,
    docs: { ...(base.meta?.docs ?? {}), description: 'SafeQL check-sql, SQL validity only (type-annotation reports filtered)' },
  },
  create(context) {
    // A derived object with its own `report`; everything else is inherited
    // from the real (frozen) rule context.
    const filtered = Object.create(context, {
      report: {
        value: (descriptor) => {
          if (descriptor && TYPE_ANNOTATION_MESSAGES.has(descriptor.messageId)) return;
          context.report(descriptor);
        },
      },
    });
    return base.create(filtered);
  },
};

const plugin = {
  meta: { name: 'eslint-plugin-safeql-sql-only', version: '1.0.0' },
  rules: { 'check-sql': checkSqlOnly },
};

export default plugin;
