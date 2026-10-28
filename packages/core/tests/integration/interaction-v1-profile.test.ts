import { describe, it, expect } from 'vitest';
import {
  VirtualClock,
  SeededRandom,
  SnowflakeGenerator,
  VirtualState,
  GatewayEmulator,
  InteractionEngine,
  createSimulationProfile,
  MessageDomainService,
} from '../../src/index.js';

function engine() {
  const clock = new VirtualClock({ nowMs: 1_800_000_000_000 });
  const random = new SeededRandom(42);
  const snowflakes = new SnowflakeGenerator(clock);
  const state = new VirtualState(clock, snowflakes, [
    { resourceType: 'guild', id: '100' },
    { resourceType: 'channel', id: '200', guild_id: '100', type: 0 },
    { resourceType: 'user', id: '300', username: 'human' },
  ]);
  const gateway = new GatewayEmulator({
    clock,
    random,
    snowflakes,
    applicationId: '400',
    botUserId: '500',
  });
  const interactions = new InteractionEngine({
    clock,
    random,
    snowflakes,
    applicationId: '400',
    profile: createSimulationProfile(),
    messageAuthority: {
      state,
      gateway,
      author: { id: '500', username: 'bot', discriminator: '0', avatar: null, bot: true },
      context: { runId: 'test' },
    },
  });
  return { state, interactions, gateway };
}
describe('SDK interaction profile', () => {
  it('keeps a component update on the original message and validates its context', () => {
    const { state, interactions } = engine();
    const context = { actorId: '300', guildId: '100', channelId: '200' };
    const command = interactions.create({
      type: 'command',
      messageProfile: 'interactions-v1',
      context,
      data: { type: 1, name: 'buttons' },
    });
    interactions.respond(command.id, 'message', { content: 'Before', components: [] });
    const message = interactions.getOriginalMessage(command.id);
    const component = interactions.create({
      type: 'component',
      messageProfile: 'interactions-v1',
      context,
      sourceMessageId: message.id,
      data: { custom_id: 'edit', component_type: 2 },
    });
    interactions.respond(component.id, 'update', { content: 'After' });
    expect(state.list('message')).toHaveLength(1);
    expect(interactions.getOriginalMessage(command.id)['content']).toBe('After');
    expect(interactions.getOriginalMessage(component.id).id).toBe(message.id);
  });
  it('accepts autocomplete through the actual callback engine and enforces the 25 choice limit', () => {
    const { interactions } = engine();
    const context = { actorId: '300', guildId: '100', channelId: '200' };
    const good = interactions.create({
      type: 'autocomplete',
      messageProfile: 'interactions-v1',
      context,
      data: { type: 1, name: 'search' },
    });
    expect(
      interactions.respond(good.id, 'autocomplete', { choices: [{ name: 'One', value: 'one' }] })
        .status,
    ).toBe('responded');
    const bad = interactions.create({
      type: 'autocomplete',
      messageProfile: 'interactions-v1',
      context,
      data: { type: 1, name: 'search' },
    });
    expect(() =>
      interactions.respond(bad.id, 'autocomplete', {
        choices: Array.from({ length: 26 }, (_, i) => ({ name: String(i), value: i })),
      }),
    ).toThrow();
    expect(interactions.get(bad.id)?.status).toBe('pending');
  });
  it('acknowledges an unchanged component update and retains followup source identity', () => {
    const { interactions } = engine();
    const context = { actorId: '300', guildId: '100', channelId: '200' };
    const initial = interactions.create({
      type: 'command',
      messageProfile: 'interactions-v1',
      context,
      data: { type: 1, name: 'ping' },
    });
    interactions.respond(initial.id, 'message', { content: 'Same' });
    const original = interactions.getOriginalMessage(initial.id);
    const component = interactions.create({
      type: 'component',
      messageProfile: 'interactions-v1',
      context,
      sourceMessageId: original.id,
      data: { custom_id: 'same', component_type: 2 },
    });
    expect(interactions.respond(component.id, 'update', { content: 'Same' }).status).toBe(
      'responded',
    );
    expect(interactions.get(component.id)?.initialResponse?.type).toBe('update');
    const followup = interactions.followup(initial.id, { content: 'A followup' });
    const click = interactions.create({
      type: 'component',
      messageProfile: 'interactions-v1',
      context,
      sourceMessageId: followup.id,
      data: { custom_id: 'followup', component_type: 2 },
    });
    interactions.respond(click.id, 'defer-update', {});
    expect(interactions.getOriginalMessage(click.id).id).toBe(followup.id);
    interactions.editOriginal(click.id, { content: 'Edited followup' });
    expect(interactions.getFollowupMessage(initial.id, followup.id)['content']).toBe(
      'Edited followup',
    );
  });
  it('updates an ordinary bot message through a component token without changing its provenance', () => {
    const { state, interactions, gateway } = engine();
    const messages = new MessageDomainService({
      state,
      gateway,
      author: { id: '500', username: 'bot', discriminator: '0', avatar: null, bot: true },
    });
    const ordinary = messages.create('200', { content: 'Ordinary' }).message;
    const context = { actorId: '300', guildId: '100', channelId: '200' };
    const click = interactions.create({
      type: 'component',
      messageProfile: 'interactions-v1',
      context,
      sourceMessageId: ordinary.id,
      data: { custom_id: 'ordinary', component_type: 2 },
    });
    interactions.respond(click.id, 'defer-update', {});
    interactions.editOriginal(click.id, { content: 'Edited ordinary' });
    expect(interactions.getOriginalMessage(click.id).id).toBe(ordinary.id);
    expect(state.require('message', ordinary.id)['content']).toBe('Edited ordinary');
    expect(state.require('message', ordinary.id)['message_origin']).not.toBe('interaction');
  });
});
