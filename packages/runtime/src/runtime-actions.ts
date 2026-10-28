import { canViewChannel } from './viewer-permissions.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  calculatePermissions,
  Permissions,
  projectMessageWire,
  type VirtualState,
  type GatewayEmulator,
  type InteractionEngine,
  type VirtualClock,
  type LocalAttachmentStore,
} from '@disrunner/core';
import {
  SessionError,
  type InvocationContext,
  type RuntimeAction,
  type RuntimeInvocationResult,
} from './contracts.js';

export interface ActionDriverOptions {
  readonly state: VirtualState;
  readonly clock: VirtualClock;
  readonly gateway: GatewayEmulator;
  readonly interactions: InteractionEngine;
  readonly applicationId: string;
  readonly attachments?: LocalAttachmentStore;
  readonly projectRoot?: string;
  readonly requireRegisteredCommands?: boolean;
  readonly enforcePermissions?: boolean;
  readonly assertLive: () => void;
  readonly transport?: (
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<{
    type: 'message' | 'defer' | 'defer-update' | 'update' | 'modal' | 'autocomplete';
    data: Readonly<Record<string, unknown>>;
  }>;
}

/** Routes user operations through the same store and transports consumed by the real SDK. */
export class RuntimeActionDriver {
  readonly announcedDirectChannels = new Set<string>();
  readonly pendingModals = new Map<string, Readonly<Record<string, unknown>>>();
  public constructor(private readonly options: ActionDriverOptions) {}
  public readAttachment(id: string, context: InvocationContext) {
    if (!this.options.attachments)
      throw new SessionError('invalid', 'Attachments are unavailable.');
    const channel = this.options.state.require('channel', context.channelId);
    if (
      this.options.enforcePermissions &&
      !canViewChannel(
        this.options.state.snapshot().resources,
        context.actorId,
        channel,
        this.options.clock.now(),
      )
    )
      throw new SessionError('invalid', 'This actor cannot view the channel.');
    const visible = this.options.state
      .list('message')
      .some(
        (message) =>
          message['channel_id'] === context.channelId &&
          message['guild_id'] === context.guildId &&
          (message['visibility'] !== 'ephemeral' || message['recipient_id'] === context.actorId) &&
          records(message['attachments']).some((file) => file['id'] === id),
      );
    const file = this.options.attachments.get(id);
    if (!visible || !file)
      throw new SessionError('invalid', 'Attachment is unavailable to this actor.');
    return { metadata: file.metadata, data: new Uint8Array(file.data) };
  }
  public async importAttachment(
    relativePath: string,
    context: InvocationContext,
    signal?: AbortSignal,
  ) {
    if (!this.options.attachments || !this.options.projectRoot)
      throw new SessionError('invalid', 'Attachments are unavailable.');
    const prepared = await this.options.attachments.addFile(this.options.projectRoot, relativePath);
    try {
      signal?.throwIfAborted();
      this.options.assertLive();
      const metadata = prepared.attachments[0]!;
      this.options.state.create('attachment', { ...metadata, owner_id: context.actorId });
      prepared.commit();
      return structuredClone(metadata);
    } catch (error) {
      prepared.rollback();
      throw error;
    }
  }
  public async dispatch(
    action: RuntimeAction,
    context: InvocationContext,
    signal: AbortSignal,
  ): Promise<RuntimeInvocationResult> {
    const started = performance.now();
    signal.throwIfAborted();
    this.options.assertLive();
    if (
      !action ||
      typeof action !== 'object' ||
      Object.keys(action).some(
        (key) =>
          ![
            'type',
            'name',
            'options',
            'customId',
            'componentType',
            'values',
            'messageId',
            'content',
            'fields',
            'commandType',
            'targetId',
          ].includes(key),
      ) ||
      Buffer.byteLength(JSON.stringify(action)) > 65536
    )
      throw new SessionError('invalid', 'Invalid action payload.');
    if (
      ![
        'command',
        'autocomplete',
        'component',
        'modal-submit',
        'message',
        'message-edit',
        'message-delete',
      ].includes(action.type)
    )
      throw new SessionError('invalid', 'Unsupported runtime action.');
    const actor = this.options.state.require('user', context.actorId);
    const channel = this.options.state.require('channel', context.channelId);
    if (channel['guild_id'] !== context.guildId)
      throw new SessionError('invalid', 'Channel does not belong to the selected guild.');
    if (
      this.options.enforcePermissions &&
      context.guildId !== undefined &&
      !this.permissions(
        context,
        action.type.startsWith('message')
          ? Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES
          : Permissions.VIEW_CHANNEL,
      ).allowed
    )
      throw new SessionError(
        'invalid',
        'The selected actor does not have the required channel permissions.',
      );
    if (channel['type'] === 1 && !this.announcedDirectChannels.has(channel.id)) {
      this.options.gateway.broadcast('CHANNEL_CREATE', {
        id: channel.id,
        type: 1,
        last_message_id: null,
        recipients: Array.isArray(channel['recipients'])
          ? records(channel['recipients']).map((r) => {
              const user = this.options.state.get('user', String(r.id));
              return user
                ? Object.fromEntries(Object.entries(user).filter(([key]) => key !== 'resourceType'))
                : r;
            })
          : [],
      });
      this.announcedDirectChannels.add(channel.id);
    }
    if (action.type.startsWith('message')) {
      if (
        action.type !== 'message-delete' &&
        (typeof action.content !== 'string' || action.content.length > 2000)
      )
        throw new SessionError('invalid', 'Message content must contain at most 2,000 characters.');
      const wireActor = Object.fromEntries(
        Object.entries(actor).filter(([key]) => key !== 'resourceType'),
      );
      let message;
      let event;
      if (action.type === 'message') {
        message = this.options.state.create('message', {
          type: 0,
          channel_id: context.channelId,
          ...(context.guildId === undefined ? {} : { guild_id: context.guildId }),
          author: wireActor,
          content: action.content,
          flags: 0,
          visibility: 'channel',
          timestamp: new Date(this.options.clock.now()).toISOString(),
          edited_timestamp: null,
          embeds: [],
          components: [],
          attachments: [],
          mentions: [],
          mention_roles: [],
          mention_everyone: false,
          pinned: false,
          tts: false,
        });
        event = 'MESSAGE_CREATE';
      } else {
        if (!action.messageId) throw new SessionError('invalid', 'A message ID is required.');
        const current = this.options.state.require('message', action.messageId);
        if (
          current['channel_id'] !== context.channelId ||
          (current['author'] as { id?: string })?.id !== context.actorId
        )
          throw new SessionError(
            'invalid',
            "Only the selected actor's messages can be edited or deleted.",
          );
        if (action.type === 'message-delete') {
          message = current;
          this.options.state.delete('message', current.id);
          event = 'MESSAGE_DELETE';
        } else {
          message = this.options.state.update('message', current.id, {
            content: action.content,
            edited_timestamp: new Date(this.options.clock.now()).toISOString(),
          });
          event = 'MESSAGE_UPDATE';
        }
      }
      this.options.gateway.broadcast(
        event,
        event === 'MESSAGE_DELETE'
          ? {
              id: message.id,
              channel_id: context.channelId,
              ...(context.guildId === undefined ? {} : { guild_id: context.guildId }),
            }
          : projectMessageWire(message),
      );
      return {
        ok: true,
        command: action.type,
        interactionId: null,
        durationMs: performance.now() - started,
        response: null,
        error: null,
      };
    }
    if (action.type === 'command' || action.type === 'autocomplete') {
      const visit = async (
        items: readonly Readonly<Record<string, unknown>>[],
      ): Promise<readonly Readonly<Record<string, unknown>>[]> =>
        Promise.all(
          items.map(async (item) => {
            if (Array.isArray(item['options']))
              return { ...item, options: await visit(item['options']) };
            if (
              item['type'] === 11 &&
              typeof item['value'] === 'string' &&
              !/^[1-9][0-9]*$/.test(item['value'])
            ) {
              const file = await this.importAttachment(item['value'], context, signal);
              return { ...item, value: file.id };
            }
            return item;
          }),
        );
      if (action.options) action = { ...action, options: await visit(action.options) };
    }
    const command = action.type === 'command' || action.type === 'autocomplete';
    if (command && context.guildId === undefined)
      throw new SessionError(
        'invalid',
        'The command profile supports guild-installed commands. Use a guild text channel.',
      );
    const data: Record<string, unknown> = command
      ? this.commandData(action, context)
      : action.type === 'component'
        ? {
            custom_id: action.customId,
            component_type: action.componentType ?? 2,
            ...(action.values ? { values: action.values } : {}),
          }
        : {
            custom_id: action.customId,
            components: Object.entries(action.fields ?? {}).map(([custom_id, value]) => ({
              type: 1,
              components: [{ type: 4, custom_id, value }],
            })),
          };
    if (
      !command &&
      (typeof action.customId !== 'string' ||
        action.customId.length < 1 ||
        action.customId.length > 100)
    )
      throw new SessionError('invalid', 'A component or modal custom ID is required.');
    if (action.type === 'modal-submit') {
      const key = this.modalKey(context, action.customId!);
      const modal = this.pendingModals.get(key);
      if (!modal)
        throw new SessionError('invalid', 'No open modal matches this actor and context.');
      const fields = records(modal['components']).flatMap((row) => records(row['components']));
      if (
        Object.keys(action.fields ?? {}).some(
          (key) => !fields.some((field) => field['custom_id'] === key),
        )
      )
        throw new SessionError('invalid', 'The submitted modal contains an unknown field.');
      for (const field of fields) {
        const fieldId = typeof field['custom_id'] === 'string' ? field['custom_id'] : '';
        const value = Object.hasOwn(action.fields ?? {}, fieldId)
          ? (action.fields![fieldId] ?? '')
          : '';
        if (
          typeof value !== 'string' ||
          value.length < Number(field['min_length'] ?? (field['required'] === false ? 0 : 1)) ||
          value.length > Number(field['max_length'] ?? 4000)
        )
          throw new SessionError('invalid', 'A modal field is outside its required bounds.');
      }
      this.pendingModals.delete(key);
    }
    if (action.type === 'component' && [5, 6, 7, 8].includes(action.componentType ?? 2))
      data['resolved'] = this.resolvedForValues(
        action.values ?? [],
        action.componentType ?? 2,
        context,
      );
    const source =
      action.messageId === undefined
        ? undefined
        : this.options.state.require('message', action.messageId);
    if (
      source &&
      (source['channel_id'] !== context.channelId ||
        (source['visibility'] === 'ephemeral' && source['recipient_id'] !== context.actorId))
    )
      throw new SessionError('invalid', 'Message is unavailable to this actor in this channel.');
    if (action.type === 'component') this.validateComponent(source, action);
    const interaction = this.options.interactions.create({
      type: action.type,
      messageProfile: 'interactions-v1',
      context,
      data,
      ...(source ? { sourceMessageId: source.id } : {}),
    });
    const member = this.options.state
      .list('member')
      .find(
        (m) =>
          m['guild_id'] === context.guildId &&
          (m['user_id'] === context.actorId || m.id === context.actorId),
      );
    const payload = {
      id: interaction.id,
      application_id: this.options.applicationId,
      type:
        action.type === 'command'
          ? 2
          : action.type === 'component'
            ? 3
            : action.type === 'autocomplete'
              ? 4
              : 5,
      token: interaction.token,
      version: 1,
      attachment_size_limit: 2097152,
      ...(context.guildId === undefined ? {} : { guild_id: context.guildId }),
      channel_id: context.channelId,
      channel: { ...channel },
      locale: 'en-US',
      guild_locale: 'en-US',
      context: context.guildId === undefined ? 1 : 0,
      app_permissions: '9007199254740991',
      entitlements: [],
      authorizing_integration_owners: context.guildId === undefined ? {} : { '0': context.guildId },
      ...(context.guildId === undefined
        ? {
            user: Object.fromEntries(
              Object.entries(actor).filter(([key]) => key !== 'resourceType'),
            ),
          }
        : {
            member: {
              roles: [],
              flags: 0,
              joined_at: new Date(0).toISOString(),
              deaf: false,
              mute: false,
              permissions: this.options.enforcePermissions
                ? this.permissions(context, 0n).effective.toString()
                : '9007199254740991',
              ...member,
              user: Object.fromEntries(
                Object.entries(actor).filter(([key]) => key !== 'resourceType'),
              ),
            },
          }),
      data,
      ...(source ? { message: projectMessageWire(source) } : {}),
    };
    let transportResponse: RuntimeInvocationResult['response'] = null;
    if (this.options.transport) {
      const response = await this.options.transport(payload, signal);
      transportResponse = structuredClone(response);
      this.options.interactions.respond(interaction.id, response.type, response.data);
    } else {
      const delivery = this.options.gateway.broadcast('INTERACTION_CREATE', payload);
      if (delivery.accepted < 1)
        throw new SessionError('transport', 'No connected SDK accepted the interaction.');
    }
    for (;;) {
      signal.throwIfAborted();
      this.options.assertLive();
      const observed = this.options.interactions.get(interaction.id);
      if (observed?.initialResponse?.type === 'modal') {
        if (this.pendingModals.size >= 100)
          throw new SessionError('transport', 'Too many open modals.');
        this.pendingModals.set(
          this.modalKey(context, String(observed.initialResponse.data['custom_id'])),
          observed.initialResponse.data,
        );
      }
      if (observed?.initialResponse)
        return {
          ok: true,
          command: action.name ?? action.customId ?? action.type,
          interactionId: interaction.id,
          durationMs: performance.now() - started,
          response: transportResponse ?? {
            type: observed.initialResponse.type,
            data: observed.initialResponse.data,
          },
          error: null,
        };
      if (observed?.status === 'expired')
        throw new SessionError(
          'timeout',
          'Bot did not acknowledge the interaction within three seconds.',
        );
      await delay(10, undefined, { signal });
    }
  }
  private commandData(action: RuntimeAction, context: InvocationContext): Record<string, unknown> {
    if (typeof action.name !== 'string' || action.name.length < 1 || action.name.length > 32)
      throw new SessionError('invalid', 'A command name is required.');
    const command = this.options.state
      .list('application-command')
      .filter(
        (c) =>
          c['name'] === action.name &&
          c['type'] === (action.commandType ?? 1) &&
          (c['guild_id'] === undefined || c['guild_id'] === context.guildId),
      )
      .sort((a, b) => Number(b['guild_id'] !== undefined) - Number(a['guild_id'] !== undefined))[0];
    if (!command && this.options.requireRegisteredCommands)
      throw new SessionError('invalid', 'The command is not registered in the selected guild.');
    const options = action.options ?? [];
    if (command)
      this.validateOptions(
        Array.isArray(command['options']) ? command['options'] : [],
        options,
        action.type === 'autocomplete',
      );
    const resolved: Record<string, Record<string, unknown>> = {};
    const collect = (items: readonly Readonly<Record<string, unknown>>[]) => {
      for (const item of items) {
        if (Array.isArray(item['options'])) collect(item['options']);
        if ([6, 7, 8, 9, 11].includes(Number(item['type'])) && typeof item['value'] === 'string')
          Object.entries(
            this.resolvedForValues(
              [item['value']],
              item['type'] === 6
                ? 5
                : item['type'] === 8
                  ? 6
                  : item['type'] === 9
                    ? 7
                    : item['type'] === 11
                      ? 11
                      : 8,
              context,
            ),
          ).forEach(([key, value]) => {
            resolved[key] = { ...resolved[key], ...value };
          });
      }
    };
    collect(options);
    const data: Record<string, unknown> = {
      id: command?.id ?? '1',
      name: action.name,
      type: action.commandType ?? 1,
      options,
      resolved,
    };
    if (action.targetId) {
      const kind = action.commandType === 3 ? 'message' : 'user';
      const target = this.options.state.require(kind, action.targetId);
      if (kind === 'message' && target['channel_id'] !== context.channelId)
        throw new SessionError('invalid', 'Target message is not in the selected channel.');
      data['target_id'] = target.id;
      data['resolved'] =
        kind === 'message'
          ? { messages: { [target.id]: projectMessageWire(target) } }
          : {
              users: { [target.id]: target },
              members: { [target.id]: { roles: [], joined_at: new Date(0).toISOString() } },
            };
    }
    return data;
  }
  private modalKey(context: InvocationContext, id: string): string {
    return JSON.stringify([context.actorId, context.guildId, context.channelId, id]);
  }
  private permissions(context: InvocationContext, requested: bigint) {
    if (context.guildId === undefined)
      throw new SessionError('invalid', 'Guild permission evaluation requires a guild.');
    const guild = this.options.state.require('guild', context.guildId);
    const member = this.options.state
      .list('member')
      .find(
        (m) =>
          m['guild_id'] === context.guildId &&
          (m['user_id'] === context.actorId || m.id === context.actorId),
      );
    if (!member)
      throw new SessionError('invalid', 'The selected actor is not a member of this guild.');
    const roles = this.options.state
      .list('role')
      .filter((r) => r['guild_id'] === context.guildId)
      .map((r) => ({
        id: r.id,
        permissions: bits(r['permissions'] ?? '0'),
        position: Number(r['position'] ?? 0),
      }));
    const channel = this.options.state.require('channel', context.channelId);
    const overwrites = Array.isArray(channel['permission_overwrites'])
      ? records(channel['permission_overwrites']).map((o) => ({
          id: identifier(o['id']),
          type: o['type'] === 0 ? ('role' as const) : ('member' as const),
          allow: bits(o['allow']),
          deny: bits(o['deny']),
        }))
      : [];
    return calculatePermissions({
      guildId: context.guildId,
      ownerId: String(guild['owner_id']),
      member: {
        id: context.actorId,
        roleIds: Array.isArray(member?.['roles']) ? member['roles'] : [],
        ...(typeof member?.['communication_disabled_until'] === 'string'
          ? { timedOutUntilMs: Date.parse(member['communication_disabled_until']) }
          : {}),
      },
      roles,
      channel: { id: context.channelId, overwrites },
      requested,
      nowMs: this.options.clock.now(),
    });
  }
  private resolvedForValues(
    values: readonly string[],
    type: number,
    context: InvocationContext,
  ): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of values) {
      if (!/^[1-9][0-9]{0,19}$/.test(id))
        throw new SessionError('invalid', 'Entity options require canonical IDs.');
      const kind =
        type === 5
          ? 'user'
          : type === 6
            ? 'role'
            : type === 8
              ? 'channel'
              : type === 11
                ? 'attachment'
                : this.options.state.get('user', id)
                  ? 'user'
                  : 'role';
      const value = this.options.state.get(kind, id);
      if (!value)
        throw new SessionError('invalid', 'Selected entity is not present in the workspace.');
      if (kind !== 'user' && kind !== 'attachment' && value['guild_id'] !== context.guildId)
        throw new SessionError('invalid', 'Selected entity belongs to a different guild.');
      const key =
        kind === 'user'
          ? 'users'
          : kind === 'role'
            ? 'roles'
            : kind === 'attachment'
              ? 'attachments'
              : 'channels';
      result[key] ??= {};
      result[key][id] = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'resourceType'),
      );
      if (kind === 'user') {
        const member = this.options.state
          .list('member')
          .find((m) => m['guild_id'] === context.guildId && (m['user_id'] === id || m.id === id));
        if (member) {
          result['members'] ??= {};
          result['members'][id] = {
            roles: [],
            joined_at: new Date(0).toISOString(),
            flags: 0,
            ...member,
          };
        }
      }
    }
    return result;
  }
  private validateOptions(
    specs: readonly Record<string, unknown>[],
    options: readonly Readonly<Record<string, unknown>>[],
    autocomplete: boolean,
  ): void {
    if (options.length > 25 || new Set(options.map((o) => o['name'])).size !== options.length)
      throw new SessionError(
        'invalid',
        'Command options must be unique and within the 25-option limit.',
      );
    for (const spec of specs)
      if (!autocomplete && spec['required'] && !options.some((o) => o['name'] === spec['name']))
        throw new SessionError('invalid', 'A required command option is missing.');
    for (const option of options) {
      const spec = specs.find((s) => s['name'] === option['name']);
      if (!spec || option['type'] !== spec['type'])
        throw new SessionError('invalid', 'Unknown command option or incorrect option type.');
      const type = Number(spec['type']);
      const value = option['value'];
      if (type === 1 || type === 2) {
        if (
          options.length !== 1 ||
          (option['options'] !== undefined && !Array.isArray(option['options']))
        )
          throw new SessionError('invalid', 'Subcommands require a single valid option path.');
        this.validateOptions(
          Array.isArray(spec['options']) ? spec['options'] : [],
          Array.isArray(option['options']) ? option['options'] : [],
          autocomplete,
        );
        continue;
      }
      if (
        type === 3 &&
        (typeof value !== 'string' ||
          (!autocomplete && value.length < Number(spec['min_length'] ?? 0)) ||
          value.length > Number(spec['max_length'] ?? 6000))
      )
        throw new SessionError('invalid', 'String option is outside its bounds.');
      if (
        !(autocomplete && option['focused'] && typeof value === 'string' && value.length <= 100) &&
        (type === 4 || type === 10) &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (type === 4 && !Number.isSafeInteger(value)) ||
          value < Number(spec['min_value'] ?? -Number.MAX_SAFE_INTEGER) ||
          value > Number(spec['max_value'] ?? Number.MAX_SAFE_INTEGER))
      )
        throw new SessionError('invalid', 'Numeric option is outside its bounds.');
      if (type === 5 && typeof value !== 'boolean')
        throw new SessionError('invalid', 'Boolean option requires true or false.');
      if (
        Array.isArray(spec['choices']) &&
        !records(spec['choices']).some((choice) => choice['value'] === value) &&
        !(autocomplete && option['focused'])
      )
        throw new SessionError('invalid', 'Option value is not one of the command choices.');
      if (option['focused'] && (!autocomplete || spec['autocomplete'] !== true))
        throw new SessionError('invalid', 'Only autocomplete options may be focused.');
    }
  }
  private validateComponent(
    source: Readonly<Record<string, unknown>> | undefined,
    action: RuntimeAction,
  ): void {
    if (!source) throw new SessionError('invalid', 'A component requires its source message.');
    const rows = source['components'];
    const components = records(rows).flatMap((row) => records(row['components']));
    const component = components.find(
      (c: Record<string, unknown>) => c['custom_id'] === action.customId,
    );
    if (
      !component ||
      component['disabled'] ||
      component['style'] === 5 ||
      component['type'] !== (action.componentType ?? 2)
    )
      throw new SessionError(
        'invalid',
        'Component is missing, disabled, or does not match its type.',
      );
    if (component['type'] !== 2) {
      const values = action.values ?? [];
      if (
        new Set(values).size !== values.length ||
        values.length < Number(component['min_values'] ?? 1) ||
        values.length > Number(component['max_values'] ?? 1)
      )
        throw new SessionError('invalid', 'Selected values are outside the component bounds.');
      if (
        component['type'] === 3 &&
        values.some((v) => !records(component['options']).some((o) => o['value'] === v))
      )
        throw new SessionError('invalid', 'Selected value is not in the available options.');
    }
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bits(value: unknown): string {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  throw new SessionError('invalid', 'Permission bitfields must be nonnegative decimal strings.');
}
function identifier(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  throw new SessionError('invalid', 'Resource IDs must be canonical positive decimal strings.');
}
