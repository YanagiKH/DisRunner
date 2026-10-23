import { describe, expect, it } from 'vitest';
import { ApplicationCommandRegistry } from '../../src/application-command-registry.js';
import {
  parseCommandFields,
  parseCommandRegistryProfile,
} from '../../src/application-command-profile.js';
import { VirtualClock } from '../../src/clock.js';
import { SnowflakeGenerator } from '../../src/random.js';
import { VirtualState, type VirtualStateOptions } from '../../src/state.js';
const APP = '111111111111111111',
  GUILD = '666666666666666666';
const payload = { name: 'ping', description: 'Ping' };
function setup(
  options: VirtualStateOptions = {},
  generator?: (clock: VirtualClock) => SnowflakeGenerator,
) {
  const clock = new VirtualClock({ nowMs: 1420070500000 });
  const state = new VirtualState(
    clock,
    generator?.(clock) ?? new SnowflakeGenerator(clock),
    [{ id: GUILD, resourceType: 'guild' }],
    options,
  );
  const service = new ApplicationCommandRegistry(state, APP, {
    profile: 'command-registry-v1',
    guildIds: [GUILD],
  });
  return { state, service };
}
function invalid(fn: () => unknown, message = 'Invalid application command payload.') {
  expect(fn).toThrow(message);
}
describe('command registry descriptor and domain contract', () => {
  it('never executes hostile proxies, prototype proxies or getters', () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++;
          throw Error('trap');
        },
        getPrototypeOf() {
          calls++;
          throw Error('trap');
        },
        ownKeys() {
          calls++;
          throw Error('trap');
        },
      },
    );
    for (const input of [
      proxy,
      { ...payload, extra: [proxy] },
      Object.create(proxy),
      {
        get name() {
          calls++;
          return 'ping';
        },
        description: 'Ping',
      },
      { ...payload, [Symbol('x')]: 1 },
      Object.assign(Object.create({ name: 'ping' }), { description: 'Ping' }),
    ])
      invalid(() => parseCommandFields(input, false));
    const cycle: Record<string, unknown> = { ...payload };
    cycle['extra'] = [cycle];
    invalid(() => parseCommandFields(cycle, false));
    invalid(() => parseCommandFields({}, false, proxy as never));
    expect(calls).toBe(0);
  });
  it('validates Unicode, defaults and neutral values without normalizing names', () => {
    expect(
      parseCommandFields(
        {
          ...payload,
          options: [],
          default_permission: true,
          name_localizations: null,
          description_localizations: null,
          default_member_permissions: null,
          nsfw: false,
          integration_types: [0],
          contexts: [0],
          dm_permission: false,
        },
        false,
      ),
    ).toEqual({ type: 1, ...payload });
    for (const name of ['A', 'a'.repeat(33), '', 'a b', '\ud800', 'a\n'])
      invalid(() => parseCommandFields({ name, description: 'x' }, false));
    for (const name of ['é', 'नमस्ते', '你好', 'a'.repeat(32)])
      expect(parseCommandFields({ name, description: 'x' }, false).name).toBe(name);
    for (const type of [null, '1', false, 1.5])
      invalid(() => parseCommandFields({ ...payload, type }, false));
    for (const input of [
      { ...payload, options: null },
      { ...payload, description: null },
      { ...payload, nsfw: 0 },
    ])
      invalid(() => parseCommandFields(input, false));
    for (const input of [
      { ...payload, type: 4 },
      { ...payload, options: [1] },
      { ...payload, options: Array.from({ length: 1025 }, () => 1) },
      { ...payload, choices: [] },
      { type: 2, name: 'Inspect', options: [] },
      { ...payload, nsfw: true },
      { ...payload, default_permission: null },
      { ...payload, contexts: [1] },
    ])
      invalid(() => parseCommandFields(input, false), 'Unsupported application command feature');
    expect(parseCommandFields({ type: 2, name: 'Inspect User' }, false)).toEqual({
      type: 2,
      name: 'Inspect User',
      description: '',
    });
    invalid(() => parseCommandFields({ type: 2, name: 'Inspect', description: 'x' }, false));
  });
  it('copies and freezes installed-guild configuration and rejects aliases/duplicates', () => {
    const input = { profile: 'command-registry-v1', guildIds: [GUILD] };
    const copy = parseCommandRegistryProfile(input);
    input.guildIds.length = 0;
    expect(copy.guildIds).toEqual([GUILD]);
    expect(Object.isFrozen(copy.guildIds)).toBe(true);
    for (const guildIds of [
      ['01'],
      [GUILD, GUILD],
      ['18446744073709551616'],
      [1],
      Array.from({ length: 129 }, (_, i) => String(i + 1)),
    ])
      invalid(() => parseCommandRegistryProfile({ profile: 'command-registry-v1', guildIds }));
    expect(
      parseCommandRegistryProfile({
        profile: 'command-registry-v1',
        guildIds: Array.from({ length: 128 }, (_, i) => String(i + 1)),
      }).guildIds,
    ).toHaveLength(128);
  });
  it('guards caller transactions and all listener no-op mutations while allowing committed reads', () => {
    const { state, service } = setup();
    service.post(APP, undefined, payload);
    const before = state.snapshot();
    invalid(
      () => state.transaction('caller', () => service.patch(APP, undefined, '419430400000', {})),
      'Command registry mutation is not allowed',
    );
    expect(state.snapshot()).toEqual(before);
    let reads = 0;
    let blocked = 0;
    state.subscribeCommits(() => {
      expect(service.list(APP)).toHaveLength(1);
      reads++;
      for (const fn of [
        () => service.post(APP, undefined, payload),
        () => service.patch(APP, undefined, '419430400000', {}),
        () => service.put(APP, GUILD, []),
      ]) {
        try {
          fn();
        } catch (e) {
          expect(String(e)).toContain('Command registry mutation is not allowed');
          blocked++;
        }
      }
    });
    service.patch(APP, undefined, '419430400000', { description: 'Pong' });
    expect(reads).toBe(1);
    expect(blocked).toBe(3);
    expect(state.revision).toBe(2);
  });
  it('rejects invalid bulk identities and collisions atomically and permits explicit rename', () => {
    const { state, service } = setup();
    service.put(APP, undefined, [payload, { type: 2, name: 'Inspect' }]);
    for (const input of [
      [payload, payload],
      [{ ...payload, id: '9' }],
      [{ type: 2, name: 'Other', id: '419430400000' }],
      [{ ...payload, id: '419430400000' }, payload],
      [
        { ...payload, id: '419430400000' },
        { type: 1, name: 'other', description: 'x', id: '419430400000' },
      ],
    ]) {
      const before = state.snapshot(),
        history = state.mutationHistory();
      invalid(() => service.put(APP, undefined, input));
      expect(state.snapshot()).toEqual(before);
      expect(state.mutationHistory()).toEqual(history);
    }
    expect(
      service.put(APP, undefined, [{ ...payload, id: '419430400000', name: 'renamed' }])[0],
    ).toMatchObject({ id: '419430400000', name: 'renamed', version: '2' });
  });
  it('enforces type counts and bulk count limits', () => {
    const { state, service } = setup();
    const slash = Array.from({ length: 100 }, (_, i) => ({ name: 'x' + i, description: 'x' }));
    service.put(APP, undefined, slash);
    const before = state.snapshot();
    invalid(
      () => service.post(APP, undefined, { name: 'extra', description: 'x' }),
      'Command registry capacity exceeded',
    );
    expect(state.snapshot()).toEqual(before);
    service.put(
      APP,
      undefined,
      Array.from({ length: 15 }, (_, i) => ({ type: 2, name: 'x' + i })),
    );
    invalid(
      () => service.post(APP, undefined, { type: 2, name: 'extra' }),
      'Command registry capacity exceeded',
    );
    service.put(APP, undefined, [
      ...slash,
      ...Array.from({ length: 15 }, (_, i) => ({ type: 2, name: 'x' + i })),
      ...Array.from({ length: 15 }, (_, i) => ({ type: 3, name: 'x' + i })),
    ]);
    expect(service.list(APP)).toHaveLength(130);
    invalid(
      () =>
        service.put(
          APP,
          undefined,
          Array.from({ length: 131 }, () => ({ ...payload })),
        ),
      'Command registry capacity exceeded',
    );
  });
  it('rolls back late capacity and generated-ID failures after tentative removal', () => {
    const { state, service } = setup({ maxResources: 2 });
    service.post(APP, undefined, payload);
    const before = state.snapshot(),
      history = state.mutationHistory();
    let commits = 0;
    state.subscribeCommits(() => commits++);
    invalid(
      () =>
        service.put(APP, undefined, [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
        ]),
      'Command registry capacity exceeded',
    );
    expect(state.snapshot()).toEqual(before);
    expect(state.mutationHistory()).toEqual(history);
    expect(commits).toBe(0);
    for (const id of ['0', '01', '18446744073709551616']) {
      class InvalidGenerator extends SnowflakeGenerator {
        public override generate(): string {
          return id;
        }
      }
      const h = setup({}, (clock) => new InvalidGenerator(clock));
      const initial = h.state.snapshot();
      invalid(() => h.service.post(APP, undefined, payload), 'Command registry capacity exceeded');
      expect(h.state.snapshot()).toEqual(initial);
    }
  });
  it('honors undo barriers, undo/redo, restore/reset and detached returned records', () => {
    const tiny = setup({ maxHistoryBytes: 1 });
    tiny.service.post(APP, undefined, payload);
    expect(tiny.state.revision).toBe(1);
    expect(tiny.state.undo()).toBe(false);
    const { state, service } = setup();
    service.put(APP, undefined, [payload, { type: 2, name: 'Inspect' }]);
    const snapshot = state.snapshot();
    expect(state.undo()).toBe(true);
    expect(service.list(APP)).toEqual([]);
    expect(state.redo()).toBe(true);
    expect(service.list(APP)).toHaveLength(2);
    const list = service.list(APP);
    (list[0] as Record<string, unknown>)['name'] = 'bad';
    expect(service.list(APP)[0]!.name).toBe('ping');
    service.patch(APP, undefined, '419430400000', { description: 'Pong' });
    state.restore(snapshot);
    expect(service.get(APP, undefined, '419430400000').version).toBe('1');
    state.reset();
    expect(service.list(APP)).toEqual([]);
  });
  it('fails closed on corrupt authoritative resources and current-version overflow', () => {
    for (const record of [
      { id: '1', resourceType: 'application-command' },
      {
        id: '1',
        resourceType: 'application-command',
        application_id: APP,
        registry_profile: 'other',
      },
    ]) {
      const { state, service } = setup();
      state.create('application-command', record);
      invalid(() => service.list(APP), 'Command registry state is invalid');
    }
    const { state, service } = setup();
    service.post(APP, undefined, payload);
    state.update('application-command', '419430400000', { version: '18446744073709551615' });
    const before = state.snapshot();
    invalid(
      () => service.patch(APP, undefined, '419430400000', { description: 'edit' }),
      'Command registry capacity exceeded',
    );
    expect(state.snapshot()).toEqual(before);
    expect(service.patch(APP, undefined, '419430400000', {}).version).toBe('18446744073709551615');
  });
  it('preserves redo through empty writes and failed plans, with one commit per bulk', () => {
    const { state, service } = setup();
    let commits = 0;
    state.subscribeCommits(() => {
      commits++;
    });
    service.put(APP, undefined, [payload, { type: 2, name: 'Inspect' }]);
    expect(commits).toBe(1);
    state.undo();
    const before = state.snapshot(),
      history = state.mutationHistory();
    service.put(APP, undefined, []);
    expect(state.snapshot()).toEqual(before);
    expect(state.mutationHistory()).toEqual(history);
    invalid(
      () => service.put(APP, undefined, [payload, { ...payload, name: 'bad', options: [1] }]),
      'Unsupported application command feature',
    );
    expect(state.snapshot()).toEqual(before);
    expect(state.mutationHistory()).toEqual(history);
    expect(state.redo()).toBe(true);
    expect(service.list(APP)).toHaveLength(2);
  });
  it('rolls back late resource-byte and state-byte failures without notifications', () => {
    for (const options of [{ maxResourceBytes: 480 }, { maxStateBytes: 600 }]) {
      const { state, service } = setup(options);
      service.post(APP, undefined, payload);
      const before = state.snapshot(),
        history = state.mutationHistory();
      let commits = 0;
      state.subscribeCommits(() => {
        commits++;
      });
      invalid(
        () => service.put(APP, undefined, [{ name: 'replacement', description: '😀'.repeat(100) }]),
        'Command registry capacity exceeded',
      );
      expect(state.snapshot()).toEqual(before);
      expect(state.mutationHistory()).toEqual(history);
      expect(commits).toBe(0);
    }
  });
  it('permits current-record high-version edits and isolates other app and guild records', () => {
    const { state, service } = setup();
    service.post(APP, undefined, payload);
    service.post(APP, GUILD, payload);
    const old = state.get('application-command', '419430400000')!;
    state.create('application-command', {
      ...old,
      id: '888888888888888888',
      application_id: '999999999999999999',
    });
    state.update('application-command', '419430400000', { version: '1000' });
    expect(service.patch(APP, undefined, '419430400000', { description: 'Updated' }).version).toBe(
      '1001',
    );
    invalid(() => service.patch(APP, GUILD, '419430400000', {}), 'Unknown application command');
    service.put(APP, undefined, []);
    expect(state.list('application-command')).toHaveLength(2);
    expect(service.list(APP, GUILD)).toHaveLength(1);
  });
  it('rejects rename collisions, generated collisions and thrown allocators without partial changes', () => {
    const { state, service } = setup();
    service.put(APP, undefined, [payload, { name: 'other', description: 'Other' }]);
    const before = state.snapshot();
    invalid(() => service.patch(APP, undefined, '419430400000', { name: 'other' }));
    expect(state.snapshot()).toEqual(before);
    class RepeatedGenerator extends SnowflakeGenerator {
      public override generate(): string {
        return '419430400000';
      }
    }
    const repeated = setup({}, (clock) => new RepeatedGenerator(clock));
    repeated.service.post(APP, undefined, payload);
    invalid(
      () => repeated.service.post(APP, undefined, { name: 'other', description: 'Other' }),
      'Command registry capacity exceeded',
    );
    expect(repeated.service.list(APP)).toHaveLength(1);
    class ThrowingGenerator extends SnowflakeGenerator {
      public override generate(): string {
        throw new Error('private allocator detail');
      }
    }
    const thrown = setup({}, (clock) => new ThrowingGenerator(clock));
    invalid(
      () => thrown.service.post(APP, undefined, payload),
      'Command registry capacity exceeded',
    );
    expect(thrown.state.revision).toBe(0);
  });
  it('bounds hostile shared DAGs before exponential copying without executing caller code', () => {
    const { state, service } = setup();
    let dag: unknown = { value: 'leaf' };
    for (let i = 0; i < 5; i++) dag = Array.from({ length: 100 }, () => dag);
    const before = state.snapshot();
    invalid(() => service.post(APP, undefined, { ...payload, extra: dag }));
    expect(state.snapshot()).toEqual(before);
  });
  it('sorts names by Unicode code point and retains request order for bulk responses', () => {
    const { service } = setup();
    const result = service.put(APP, undefined, [
      { type: 2, name: '𐀀' },
      { type: 2, name: '\ue000' },
      { type: 2, name: 'A' },
      payload,
    ]);
    expect(result.map((c) => c.id)).toEqual([
      '419430400000',
      '419430400001',
      '419430400002',
      '419430400003',
    ]);
    expect(service.list(APP).map((c) => c.name)).toEqual(['ping', 'A', '\ue000', '𐀀']);
  });
});
