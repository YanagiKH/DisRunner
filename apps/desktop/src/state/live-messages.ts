import type { InvocationContext, SessionSnapshot } from '@disrunner/runtime';
import type { ChatMessage } from '../types';

export interface LiveMessages {
  readonly status: 'available' | 'truncated' | 'unavailable';
  readonly messages: readonly ChatMessage[];
}

/** Read only the accepted session's retained projection; never merge callback evidence. */
export function selectLiveMessages(
  snapshot: SessionSnapshot,
  context: InvocationContext | undefined,
): LiveMessages {
  const core = snapshot.coreState;
  if (
    snapshot.phase !== 'running' ||
    snapshot.disposed ||
    snapshot.runId === null ||
    !core ||
    core.runId !== snapshot.runId ||
    !context ||
    !snapshot.contexts.some(
      (candidate) =>
        candidate.guildId === context.guildId &&
        candidate.channelId === context.channelId &&
        candidate.actorId === context.actorId,
    )
  )
    return { status: 'unavailable', messages: [] };

  const messages: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const resource of core.resources) {
    const privateMessage =
      resource.visibility === 'ephemeral' && resource.visibleTo === context.actorId;
    if (
      resource.resourceType !== 'message' ||
      (resource.visibility !== 'channel' && !privateMessage) ||
      resource.guild_id !== context.guildId ||
      resource.channel_id !== context.channelId ||
      (resource.type !== 0 && resource.type !== 20) ||
      typeof resource.content !== 'string' ||
      typeof resource.flags !== 'number' ||
      !Number.isSafeInteger(resource.flags) ||
      !(privateMessage ? [64, 68, 4160, 4164] : [0, 4, 4096, 4100]).includes(resource.flags) ||
      seen.has(resource.id)
    )
      continue;
    seen.add(resource.id);
    messages.push({
      id: resource.id,
      author:
        resource.author?.global_name ??
        resource.author?.username ??
        resource.author?.id ??
        'Unknown author',
      authorRole: resource.author?.bot ? 'bot' : 'member',
      content: resource.content,
      time: resource.timestamp ?? 'Time unavailable',
      ...(privateMessage ? { responseState: 'ephemeral' as const } : {}),
      ...(resource.embeds?.length ? { embeds: resource.embeds } : {}),
      ...(resource.components?.length ? { components: resource.components } : {}),
      ...(resource.attachments?.length ? { attachments: resource.attachments } : {}),
      ...(resource.author?.id === context.actorId ? { editable: true } : {}),
    });
  }
  return {
    status: core.truncated && core.evidenceComplete !== true ? 'truncated' : 'available',
    messages,
  };
}
