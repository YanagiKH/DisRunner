import { describe, expect, it } from 'vitest';

import type { ResourceRecord } from '../../src/contracts.js';
import {
  interactionMessagePayload,
  validateInteractionMessagePayload,
} from '../../src/interaction-message-domain.js';

const MAX_BYTES = 1_048_576;
const row = (component: Record<string, unknown>) => ({ type: 1, components: [component] });
const normalize = (data: Record<string, unknown>, current?: ResourceRecord) =>
  validateInteractionMessagePayload(data, MAX_BYTES, current, false, true);

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: '123456789012345678',
    filename: 'report.txt',
    size: 4,
    content_type: 'text/plain',
    url: 'http://127.0.0.1:32145/attachments/123456789012345678/report.txt',
    proxy_url: 'http://127.0.0.1:32145/attachments/123456789012345678/report.txt',
    sha256: '0123456789abcdef'.repeat(4),
    ...overrides,
  };
}

describe('interactions-v1 message controls and local attachments', () => {
  it('accepts emoji-only buttons and all five legacy select types', () => {
    expect(
      normalize({
        components: [
          row({ type: 2, style: 1, emoji: { name: '👍', id: null }, custom_id: 'vote' }),
        ],
      }),
    ).toMatchObject({
      components: [row({ type: 2, style: 1, emoji: { name: '👍', id: null }, custom_id: 'vote' })],
    });
    const components = [
      row({
        type: 3,
        custom_id: 'format',
        min_values: 1,
        max_values: 2,
        disabled: false,
        required: true,
        options: [
          { label: 'Text', value: 'text', default: true },
          { label: 'JSON', value: 'json', description: 'Structured data', emoji: { name: '📄' } },
        ],
      }),
      row({ type: 5, custom_id: 'user', default_values: [{ type: 'user', id: '10' }] }),
      row({ type: 6, custom_id: 'role', default_values: [{ type: 'role', id: '20' }] }),
      row({
        type: 7,
        custom_id: 'mention',
        max_values: 2,
        default_values: [
          { type: 'user', id: '10' },
          { type: 'role', id: '20' },
        ],
      }),
      row({
        type: 8,
        custom_id: 'channel',
        placeholder: 'Select a channel',
        channel_types: [0, 2],
        default_values: [{ type: 'channel', id: '30' }],
      }),
    ];
    expect(normalize({ components })['components']).toEqual(components);
    expect(() => validateInteractionMessagePayload({ components }, MAX_BYTES)).toThrow(
      'Invalid interaction message payload.',
    );
  });

  it('keeps valid extended controls and attachments through partial edits and detached projection', () => {
    const components = [row({ type: 8, custom_id: 'destination', channel_types: [0] })];
    const attachments = [attachment({ description: 'Local report' })];
    const created = normalize({ components, attachments, content: 'Before' });
    const current: ResourceRecord = { resourceType: 'message', id: '50', ...created };
    const edited = normalize({ content: 'After' }, current);
    expect(edited).toMatchObject({ content: 'After', components, attachments });
    const projected = interactionMessagePayload({ ...current, ...edited });
    expect(projected).toEqual(edited);
    (projected['attachments'] as Record<string, unknown>[])[0]!['filename'] = 'changed.txt';
    expect((edited['attachments'] as Record<string, unknown>[])[0]!['filename']).toBe('report.txt');
    expect(() =>
      validateInteractionMessagePayload({ content: 'Legacy edit' }, MAX_BYTES, current),
    ).toThrow();
  });

  it('allows an attachment-only message only after full local metadata resolution', () => {
    expect(normalize({ attachments: [attachment()] })).toMatchObject({
      content: '',
      attachments: [attachment()],
    });
    expect(() =>
      validateInteractionMessagePayload({ attachments: [attachment()] }, MAX_BYTES),
    ).toThrow();
    expect(() => normalize({ attachments: [{ id: '0', filename: 'report.txt' }] })).toThrow();
    expect(
      normalize(
        { attachments: null },
        { resourceType: 'message', id: '1', ...normalize({ attachments: [attachment()] }) },
      )['attachments'],
    ).toEqual([]);
  });

  it.each([
    row({ type: 2, style: 1, custom_id: 'missing-label-emoji' }),
    row({
      type: 2,
      style: 1,
      label: 'Go',
      custom_id: 'bad-emoji',
      emoji: { id: null, name: null },
    }),
    row({
      type: 2,
      style: 1,
      label: 'Go',
      custom_id: 'bad-emoji',
      emoji: { name: 'x', animated: true },
    }),
    row({ type: 2, style: 5, label: 'Link', custom_id: 'not-a-link', url: 'https://example.org/' }),
    row({ type: 3, custom_id: 'empty', options: [] }),
    row({
      type: 3,
      custom_id: 'choices',
      options: [
        { label: 'A', value: 'same' },
        { label: 'B', value: 'same' },
      ],
    }),
    row({ type: 3, custom_id: 'too-many', options: [{ label: 'One', value: '1' }], max_values: 2 }),
    row({ type: 5, custom_id: 'range', min_values: 3, max_values: 2 }),
    row({ type: 5, custom_id: 'wrong-default', default_values: [{ type: 'role', id: '20' }] }),
    row({ type: 6, custom_id: 'bad-id', default_values: [{ type: 'role', id: '01' }] }),
    row({
      type: 7,
      custom_id: 'duplicate-default',
      max_values: 2,
      default_values: [
        { type: 'user', id: '10' },
        { type: 'user', id: '10' },
      ],
    }),
    row({ type: 8, custom_id: 'bad-channel', channel_types: [999] }),
    row({ type: 5, custom_id: 'unsupported-options', options: [{ label: 'No', value: 'no' }] }),
    row({ type: 4, custom_id: 'modal-input', label: 'Name', style: 1 }),
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Go', custom_id: 'button' },
        { type: 5, custom_id: 'select' },
      ],
    },
  ])('rejects malformed controls: %j', (componentRow) => {
    expect(() => normalize({ components: [componentRow] })).toThrow(
      'Invalid interaction message payload.',
    );
  });

  it('rejects duplicate custom IDs across select and button rows', () => {
    expect(() =>
      normalize({
        components: [
          row({ type: 2, style: 1, label: 'Go', custom_id: 'duplicate' }),
          row({ type: 5, custom_id: 'duplicate' }),
        ],
      }),
    ).toThrow();
  });

  it.each([
    { id: '0' },
    { id: '01' },
    { id: '18446744073709551616' },
    { filename: '../report.txt' },
    { filename: 'folder\\report.txt' },
    { size: 2_097_153 },
    { size: -1 },
    { size: 0.5 },
    { url: 'https://cdn.discordapp.com/attachments/1/report.txt' },
    { proxy_url: 'http://127.0.0.1.evil.test/report.txt' },
    { content_type: 'text/plain\r\nx-private: secret' },
    { sha256: 'invalid' },
    { extra: 'private-path' },
  ])('rejects invalid or remote attachment metadata: %j', (changes) => {
    expect(() => normalize({ attachments: [attachment(changes)] })).toThrow();
  });

  it('enforces attachment count, byte budgets and detached safe data boundaries', () => {
    expect(() =>
      normalize({
        attachments: Array.from({ length: 11 }, (_, index) =>
          attachment({ id: String(index + 1) }),
        ),
      }),
    ).toThrow();
    expect(() =>
      normalize({
        attachments: Array.from({ length: 5 }, (_, index) =>
          attachment({ id: String(index + 1), size: 2_097_152 }),
        ),
      }),
    ).toThrow();
    let read = false;
    const source = {
      resourceType: 'message',
      id: '1',
      get content() {
        read = true;
        return 'secret';
      },
    };
    expect(() => interactionMessagePayload(source)).toThrow();
    expect(read).toBe(false);
  });
});
