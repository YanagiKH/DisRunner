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
});
