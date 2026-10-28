import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, RuntimeResourceView } from '@disrunner/runtime';
import { selectLiveMessages } from './live-messages';

const context = { guildId: 'g', channelId: 'c', actorId: 'a' };
const ordinary = {
  id: 'm',
  resourceType: 'message',
  visibility: 'channel',
  guild_id: 'g',
  channel_id: 'c',
  type: 0,
  flags: 0,
  content: 'Hello',
  timestamp: '2026-10-22T00:00:00Z',
  author: { id: 'u', username: 'User' },
};
function snapshot(resources: unknown[] = [ordinary]): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session',
    runId: 'run',
    revision: 9,
    disposed: false,
    contexts: [context],
    phase: 'running',
    project: null,
    error: null,
    pid: 1,
    endpoints: null,
    output: [],
    traces: [],
    risks: [],
    coreState: {
      schemaVersion: 1,
      runId: 'run',
      stateRevision: 3,
      revisioned: true,
      clock: { domain: 'bot', mode: 'realtime', nowMs: 1 },
      resources: resources as RuntimeResourceView[],
      totalResources: resources.length,
      truncated: false,
    },
  };
}
describe('read-only live ordinary message selector', () => {
  it('uses literal retained message fields, not publication revision as core revision', () => {
    expect(selectLiveMessages(snapshot(), context)).toEqual({
      status: 'available',
      messages: [
        {
          id: 'm',
          author: 'User',
          authorRole: 'member',
          content: 'Hello',
          time: '2026-10-22T00:00:00Z',
        },
      ],
    });
  });
  it.each([undefined, 'ephemeral', 'unknown'])('rejects visibility %s', (visibility) => {
    expect(selectLiveMessages(snapshot([{ ...ordinary, visibility }]), context).messages).toEqual(
      [],
    );
  });
  it.each([
    undefined,
    -1,
    0.5,
    64,
    68,
    4160,
    4294967360,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    8,
    '0',
  ])('rejects flags %s', (flags) => {
    expect(selectLiveMessages(snapshot([{ ...ordinary, flags }]), context).messages).toEqual([]);
  });
  it.each([0, 4, 4096, 4100])('allows supported ordinary flags %s', (flags) => {
    expect(
      selectLiveMessages(snapshot([{ ...ordinary, flags }]), context).messages.map((row) => row.id),
    ).toEqual(['m']);
  });
  it('rejects wrong channel/guild/type and non-message resources', () => {
    expect(
      selectLiveMessages(
        snapshot([
          { ...ordinary, guild_id: 'other' },
          { ...ordinary, channel_id: 'other' },
          { ...ordinary, type: 19 },
          { ...ordinary, type: undefined },
          { ...ordinary, resourceType: 'channel' },
        ]),
        context,
      ).messages,
    ).toEqual([]);
  });
  it('clears unavailable, stopped, disposed, stale run and invalid context projections', () => {
    const current = snapshot();
    for (const value of [
      { ...current, coreState: null },
      { ...current, phase: 'ready' as const },
      { ...current, disposed: true },
      { ...current, runId: 'new' },
      { ...current, contexts: [] },
    ]) {
      expect(selectLiveMessages(value, context)).toEqual({ status: 'unavailable', messages: [] });
    }
  });
  it('replaces a bounded projection without inventing deleted rows', () => {
    const current = snapshot();
    expect(
      selectLiveMessages(
        { ...current, coreState: { ...current.coreState!, resources: [], truncated: true } },
        context,
      ),
    ).toEqual({ status: 'truncated', messages: [] });
    expect(
      selectLiveMessages(snapshot([{ ...ordinary, content: 'Edited' }]), context).messages.map(
        (row) => row.content,
      ),
    ).toEqual(['Edited']);
  });
  it('does not label intentional viewer filtering as capacity truncation', () => {
    const current = snapshot();
    expect(
      selectLiveMessages(
        {
          ...current,
          coreState: { ...current.coreState!, truncated: true, evidenceComplete: true },
        },
        context,
      ).status,
    ).toBe('available');
  });
});

describe('interaction response rows in the live selector', () => {
  const original = {
    ...ordinary,
    id: 'original-1',
    type: 20,
    content: 'Original public.',
    timestamp: '2015-01-01T00:01:40.000Z',
    author: { id: '333333333333333333', username: 'fixture-bot', bot: true },
  };
  it('renders a private response only for its bound actor', () => {
    const privateReply = {
      ...original,
      id: 'private-1',
      visibility: 'ephemeral',
      flags: 64,
      visibleTo: 'a',
      content: 'For actor A',
    };
    const current = snapshot([privateReply]);
    expect(selectLiveMessages(current, context).messages).toEqual([
      expect.objectContaining({
        id: 'private-1',
        content: 'For actor A',
        responseState: 'ephemeral',
      }),
    ]);
    const other = { ...context, actorId: 'b' };
    expect(selectLiveMessages({ ...current, contexts: [context, other] }, other).messages).toEqual(
      [],
    );
  });
  it('accepts a public type 20 response with each supported flag value', () => {
    for (const flags of [0, 4, 4096, 4100]) {
      expect(
        selectLiveMessages(snapshot([{ ...original, flags }]), context).messages.map(
          (row) => row.id,
        ),
      ).toEqual(['original-1']);
    }
  });
  it('rejects other message types and ephemeral or loading flags for type 0 and 20', () => {
    const rejected = [
      { ...original, type: 19 },
      { ...original, type: 21 },
      { ...original, type: '20' },
      ...[0, 20].flatMap((type) => [64, 128, 192].map((flags) => ({ ...original, type, flags }))),
    ];
    expect(selectLiveMessages(snapshot(rejected), context).messages).toEqual([]);
  });
  it('renders a public original as one bot row with its literal fields', () => {
    expect(selectLiveMessages(snapshot([original]), context)).toEqual({
      status: 'available',
      messages: [
        {
          id: 'original-1',
          author: 'fixture-bot',
          authorRole: 'bot',
          content: 'Original public.',
          time: '2015-01-01T00:01:40.000Z',
        },
      ],
    });
  });
  it('shows no response row for stale, unavailable or foreign-context snapshots', () => {
    const current = snapshot([original]);
    for (const value of [
      { ...current, coreState: null },
      { ...current, runId: 'new' },
      { ...current, disposed: true },
      { ...current, contexts: [] },
    ]) {
      expect(selectLiveMessages(value, context)).toEqual({ status: 'unavailable', messages: [] });
    }
    expect(selectLiveMessages(current, { ...context, channelId: 'other' }).messages).toEqual([]);
  });
});
