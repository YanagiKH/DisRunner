import { describe, expect, it } from 'vitest';

import {
  findFocusedAutocompleteOptionType,
  validateAutocompleteResponse,
  validateLegacyModalResponse,
} from '../../src/interaction-controls.js';

function input(changes: Record<string, unknown> = {}) {
  return {
    type: 4,
    custom_id: 'comment',
    label: 'Comment',
    style: 2,
    required: true,
    min_length: 1,
    max_length: 4000,
    ...changes,
  };
}
function modal(changes: Record<string, unknown> = {}) {
  return {
    custom_id: 'feedback',
    title: 'Feedback',
    components: [{ type: 1, components: [input()] }],
    ...changes,
  };
}
function rejects(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ status: 400, code: 50035 }));
}

describe('strict interactions-v1 legacy modal payloads', () => {
  it('accepts detached JavaScript and Python SDK text-input payloads and all five rows', () => {
    const source = modal({
      components: [
        {
          type: 1,
          components: [input({ value: 'Prefilled', placeholder: 'Share your feedback' })],
        },
      ],
    });
    const result = validateLegacyModalResponse(source);
    expect(result).toEqual(source);
    source.title = 'Changed';
    expect(result['title']).toBe('Feedback');
    const python = modal({
      components: [
        {
          type: 1,
          id: 0,
          components: [input({ id: 1, style: 1, required: false, min_length: 0, value: '' })],
        },
      ],
    });
    expect(validateLegacyModalResponse(python)).toEqual(python);
    const five = modal({
      components: Array.from({ length: 5 }, (_, index) => ({
        type: 1,
        components: [
          input({ custom_id: 'field-' + index, label: 'Field ' + index, value: 'x'.repeat(4000) }),
        ],
      })),
    });
    expect(validateLegacyModalResponse(five)).toEqual(five);
    // A prefilled answer can be shorter than the eventual submission minimum.
    expect(
      validateLegacyModalResponse(
        modal({
          components: [{ type: 1, components: [input({ min_length: 10, value: 'Edit me' })] }],
        }),
      ),
    ).toHaveProperty('components');
  });

  it.each([
    { title: '' },
    { title: 'x'.repeat(46) },
    { custom_id: '' },
    { custom_id: 'x'.repeat(101) },
    { flags: 32768 },
    { components: [] },
    {
      components: Array.from({ length: 6 }, (_, index) => ({
        type: 1,
        components: [input({ custom_id: 'field-' + index })],
      })),
    },
    { components: [{ type: 1, components: [] }] },
    { components: [{ type: 1, components: [input(), input({ custom_id: 'second' })] }] },
    { components: [{ type: 18, label: 'Label', component: input() }] },
    {
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Button', custom_id: 'button' }] },
      ],
    },
    {
      components: [
        { type: 1, components: [input()] },
        { type: 1, components: [input()] },
      ],
    },
    { components: [{ type: 1, id: 1, components: [input({ id: 1 })] }] },
  ])('rejects malformed modal structures: %j', (changes) =>
    rejects(() => validateLegacyModalResponse(modal(changes))),
  );

  it.each([
    { custom_id: '' },
    { custom_id: 'x'.repeat(101) },
    { label: '' },
    { label: 'x'.repeat(46) },
    { style: 0 },
    { style: 3 },
    { style: '1' },
    { required: 1 },
    { min_length: -1 },
    { min_length: 4001 },
    { min_length: 5, max_length: 4 },
    { max_length: 0 },
    { max_length: 4001 },
    { max_length: 4.5 },
    { value: 'x'.repeat(4001) },
    { value: null },
    { placeholder: 'x'.repeat(101) },
    { id: -1 },
    { id: 4294967296 },
    { disabled: true },
    { options: [] },
  ])('rejects invalid text-input fields: %j', (changes) =>
    rejects(() =>
      validateLegacyModalResponse(
        modal({ components: [{ type: 1, components: [input(changes)] }] }),
      ),
    ),
  );

  it('rejects object code, aliases, cycles, unknown keys and excessive bytes without executing getters', () => {
    let calls = 0;
    const getter = {
      get title() {
        calls++;
        return 'Secret';
      },
      custom_id: 'modal',
      components: [],
    };
    rejects(() => validateLegacyModalResponse(getter));
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++;
        },
        ownKeys() {
          calls++;
          return [];
        },
        getPrototypeOf() {
          calls++;
          return null;
        },
      },
    );
    rejects(() => validateLegacyModalResponse(proxy));
    expect(calls).toBe(0);
    const shared = input();
    rejects(() =>
      validateLegacyModalResponse(
        modal({
          components: [
            { type: 1, components: [shared] },
            { type: 1, components: [shared] },
          ],
        }),
      ),
    );
    const cycle: Record<string, unknown> = modal();
    cycle['components'] = [cycle];
    rejects(() => validateLegacyModalResponse(cycle));
    rejects(() => validateLegacyModalResponse(modal(), 64));
    expect(validateLegacyModalResponse(modal(), 1024)).toHaveProperty('title', 'Feedback');
  });
});

describe('strict typed autocomplete response choices', () => {
  it('finds the focused option through groups/subcommands without inferring it from the response', () => {
    const data = {
      name: 'admin',
      options: [
        {
          type: 2,
          name: 'member',
          options: [
            {
              type: 1,
              name: 'search',
              options: [
                { type: 4, name: 'limit', value: 1, focused: true },
                { type: 3, name: 'query', value: '', focused: false },
              ],
            },
          ],
        },
      ],
    };
    expect(findFocusedAutocompleteOptionType(data)).toBe(4);
    expect(findFocusedAutocompleteOptionType({ name: 'search', options: [] })).toBeUndefined();
    rejects(() =>
      validateAutocompleteResponse(
        { choices: [{ name: 'Invalid integer', value: 0.5 }] },
        1024,
        findFocusedAutocompleteOptionType(data),
      ),
    );
    rejects(() =>
      findFocusedAutocompleteOptionType({
        options: [
          { type: 3, focused: true },
          { type: 4, focused: true },
        ],
      }),
    );
    rejects(() => findFocusedAutocompleteOptionType({ options: [{ type: 5, focused: true }] }));
    rejects(() => findFocusedAutocompleteOptionType({ options: [{ type: 3, focused: 'true' }] }));
  });
  it('accepts empty/25 choices and matches string, integer and numeric focused options', () => {
    expect(validateAutocompleteResponse({ choices: [] })).toEqual({ choices: [] });
    const strings = {
      choices: Array.from({ length: 25 }, (_, index) => ({
        name: 'Choice ' + index,
        value: String(index),
      })),
    };
    expect(validateAutocompleteResponse(strings, 1_048_576, 3)).toEqual(strings);
    expect(
      validateAutocompleteResponse({ choices: [{ name: 'Clear', value: '' }] }, 1024, 3),
    ).toEqual({ choices: [{ name: 'Clear', value: '' }] });
    expect(
      validateAutocompleteResponse({ choices: [{ name: 'One', value: 1 }] }, 1024, 4),
    ).toHaveProperty('choices');
    expect(
      validateAutocompleteResponse({ choices: [{ name: 'Half', value: 0.5 }] }, 1024, 10),
    ).toHaveProperty('choices');
    strings.choices[0]!.value = 'changed';
    const detachedSource = { choices: [{ name: 'One', value: '1' }] };
    const detached = validateAutocompleteResponse(detachedSource);
    detachedSource.choices[0]!.value = 'changed';
    expect(detached).toEqual({ choices: [{ name: 'One', value: '1' }] });
  });

  it.each([
    {
      choices: Array.from({ length: 26 }, (_, index) => ({
        name: 'Choice ' + index,
        value: index,
      })),
    },
    { choices: [{ name: '', value: 'x' }] },
    { choices: [{ name: 'x'.repeat(101), value: 'x' }] },
    { choices: [{ name: 'x', value: 'x'.repeat(101) }] },
    { choices: [{ name: 'x', value: Infinity }] },
    { choices: [{ name: 'x', value: NaN }] },
    { choices: [{ name: 'x', value: false }] },
    { choices: [{ name: 'x' }] },
    { choices: [{ name: 'x', value: 'x', extra: true }] },
    { choices: [{ name: 'x', value: 'x', name_localizations: {} }] },
    { choices: [], flags: 64 },
    { choices: {} },
    {},
  ])('rejects malformed autocomplete payloads: %j', (value) =>
    rejects(() => validateAutocompleteResponse(value)),
  );

  it('rejects focused option type mismatches and unsupported option types', () => {
    rejects(() =>
      validateAutocompleteResponse({ choices: [{ name: 'Numeric', value: 1 }] }, 1024, 3),
    );
    rejects(() =>
      validateAutocompleteResponse({ choices: [{ name: 'Fraction', value: 0.5 }] }, 1024, 4),
    );
    rejects(() =>
      validateAutocompleteResponse({ choices: [{ name: 'String', value: '1' }] }, 1024, 10),
    );
    rejects(() => validateAutocompleteResponse({ choices: [] }, 1024, 5));
  });
});
