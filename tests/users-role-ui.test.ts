import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The UI layer of role selection in /settings/users (10/10/2026):
//   • the create form has no default role — with nothing chosen no card is
//     pressed, so a click that did not land can no longer send "מנהל";
//   • each editor is offered exactly the roles they may assign: a super
//     admin all six, an admin the four below it (never admin / super admin),
//     and the list is the same predicate the routes enforce.

import { RoleSelector } from '@/components/settings/users/RoleSelector';
import { canManageRole } from '@/lib/permissions/check';
import { ROLE_VALUES, roleLabel, type Role } from '@/lib/permissions/constants';

const render = (value: Role | null, allowedRoles?: readonly Role[]) =>
  renderToStaticMarkup(createElement(RoleSelector, { value, onChange: () => undefined, allowedRoles }));
const offeredFor = (editor: Role) => ROLE_VALUES.filter((r) => canManageRole(editor, r));
const labelsIn = (html: string) => ROLE_VALUES.filter((r) => html.includes(`>${roleLabel(r)}<`));

describe('RoleSelector — nothing is chosen until the editor chooses', () => {
  it('value null: every card is unpressed', () => {
    const html = render(null);
    expect(html.match(/aria-pressed="true"/g)).toBeNull();
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(ROLE_VALUES.length);
  });

  it('a chosen role is the one pressed card', () => {
    const html = render('maintenance');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const pressed = html.slice(html.indexOf('aria-pressed="true"'));
    expect(pressed.indexOf(`>${roleLabel('maintenance')}<`)).toBeGreaterThan(-1);
    expect(pressed.indexOf(`>${roleLabel('maintenance')}<`)).toBeLessThan(pressed.indexOf('</button>'));
  });
});

describe('RoleSelector — the roles each editor is offered', () => {
  it('super admin: all six', () => {
    expect(labelsIn(render(null, offeredFor('super_admin')))).toEqual(ROLE_VALUES);
  });

  it('admin: manager, viewer, cleaner, maintenance — never admin or super admin', () => {
    expect(labelsIn(render(null, offeredFor('admin')))).toEqual(['manager', 'viewer', 'cleaner', 'maintenance']);
  });

  it.each(['manager', 'viewer', 'cleaner', 'maintenance'] as const)('%s: nothing', (editor) => {
    expect(offeredFor(editor)).toEqual([]);
  });
});
