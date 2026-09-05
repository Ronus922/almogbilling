/**
 * SafeQL plugin for this codebase's query style.
 *
 * SafeQL's built-in targets only see tagged templates (sql`…`). Here every
 * statement is a plain template literal handed to one of four functions:
 *   query(`…`, [params])  queryOne(`…`, [params])  client.query(`…`)  pool.query(`…`)
 * This plugin claims those CallExpressions and hands SafeQL the literal SQL, so
 * it is validated against the live schema (unknown table/column, syntax error,
 * wrong parameter count). Two deliberate limits:
 *   - Dynamic SQL (template with ${…}, a variable, string concatenation) is
 *     skipped: there is no static text to validate. Those sites are built from
 *     whitelisted fragments by their callers.
 *   - Type annotations (queryOne<UserRow>) are NOT compared to the inferred
 *     result type: the codebase uses hand-written interfaces on purpose, and
 *     the check would demand inline literal types. SQL validity only.
 */
import { definePlugin } from '@ts-safeql/plugin-utils';
import ts from 'typescript';

const CALLEES = new Set(['query', 'queryOne', 'client.query', 'pool.query']);

export default definePlugin({
  name: 'billing-pg-template',
  package: './scripts/lint/safeql-pg-plugin.ts',
  setup: () => ({
    queryNodeKinds: [{ kind: 'CallExpression' }],
    resolveQuery({ tsNode }) {
      if (!ts.isCallExpression(tsNode)) return 'skip';
      const callee = tsNode.expression.getText().replace(/^this\./, '');
      if (!CALLEES.has(callee)) return 'skip';
      const arg = tsNode.arguments[0];
      if (!arg) return 'skip';
      if (!ts.isNoSubstitutionTemplateLiteral(arg) && !ts.isStringLiteral(arg)) return 'skip';
      return { kind: 'sql', text: arg.text, sourcemaps: [], typeCheck: () => [] };
    },
  }),
});
