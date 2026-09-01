import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CloudOff,
  Hash,
  LockKeyhole,
  Plus,
  Radio,
  Settings,
  Users,
} from 'lucide-react';
import type { Guild } from '../types';

interface GuildSidebarProps {
  readonly guilds: readonly Guild[];
  readonly selectedGuild: Guild;
  readonly selectedChannelId: string;
  readonly onGuildSelect: (guildId: string) => void;
  readonly onChannelSelect: (channelId: string) => void;
}

export function GuildSidebar({
  guilds,
  selectedGuild,
  selectedChannelId,
  onGuildSelect,
  onChannelSelect,
}: GuildSidebarProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <aside className="guild-sidebar" aria-label="Virtual servers and channels">
      <div className="sidebar-scroll">
        <div className="sidebar-title-row">
          <span>Servers</span>
          <button aria-label="Create virtual server unavailable" disabled type="button">
            <Plus size={17} />
          </button>
        </div>
        <div className="selected-server">
          <span className="server-sample-dot" />
          <strong>{selectedGuild.name}</strong>
          <span className="preview-label">Sample</span>
        </div>

        <div className="channel-groups">
          {selectedGuild.groups.map((group) => {
            const collapsed = collapsedGroups.has(group.id);
            return (
              <section className="channel-group" key={group.id}>
                <button
                  aria-expanded={!collapsed}
                  className="channel-group-title"
                  onClick={() => toggleGroup(group.id)}
                  type="button"
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span>{group.name}</span>
                </button>
                {!collapsed && (
                  <div className="channel-list">
                    {group.channels.map((channel) => {
                      const active = channel.id === selectedChannelId;
                      return (
                        <button
                          aria-current={active ? 'page' : undefined}
                          className={`channel-row ${active ? 'active' : ''}`}
                          key={channel.id}
                          onClick={() => onChannelSelect(channel.id)}
                          type="button"
                        >
                          {channel.locked ? <LockKeyhole size={15} /> : <Hash size={17} />}
                          <span>{channel.name}</span>
                          {active && (
                            <span className="channel-actions" aria-hidden="true">
                              <Users size={14} />
                              <Settings size={14} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <div className="other-servers" aria-label="Other virtual servers">
          {guilds
            .filter((guild) => guild.id !== selectedGuild.id)
            .map((guild) => (
              <button
                className="other-server-row"
                key={guild.id}
                onClick={() => onGuildSelect(guild.id)}
                type="button"
              >
                <span
                  className="guild-mini-mark"
                  style={{ '--guild-accent': guild.accent } as React.CSSProperties}
                >
                  {guild.mark}
                </span>
                <span>{guild.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
        </div>
      </div>
      <div className="offline-guarantee">
        <div className="offline-icon">
          <CloudOff size={22} />
        </div>
        <div>
          <strong>Simulator traffic is local</strong>
          <span>Imported bot code is not OS-sandboxed.</span>
        </div>
        <Radio className="offline-pulse" size={14} />
      </div>
    </aside>
  );
}
