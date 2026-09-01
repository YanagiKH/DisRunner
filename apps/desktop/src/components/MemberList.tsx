import { Bot, UserRound } from 'lucide-react';
import type { Member } from '../types';

interface MemberListProps {
  readonly members: readonly Member[];
}

function MemberRow({ member }: { readonly member: Member }) {
  return (
    <li className={`member-row ${member.status}`}>
      <span
        className="member-avatar"
        style={{ '--avatar-color': member.color } as React.CSSProperties}
      >
        {member.role === 'bot' ? <Bot size={18} /> : <UserRound size={18} />}
        <span className={`presence ${member.status}`} />
      </span>
      <span className="member-copy">
        <span className="member-name">
          {member.name}
          {member.role === 'bot' && <small>BOT</small>}
        </span>
        {member.detail && <span>{member.detail}</span>}
      </span>
    </li>
  );
}

export function MemberList({ members }: MemberListProps) {
  const bots = members.filter((member) => member.role === 'bot');
  const online = members.filter((member) => member.role !== 'bot' && member.status === 'online');
  const offline = members.filter((member) => member.role !== 'bot' && member.status === 'offline');
  const sections: readonly { readonly label: string; readonly members: readonly Member[] }[] = [
    { label: 'Bots', members: bots },
    { label: 'Online', members: online },
    { label: 'Offline', members: offline },
  ];
  return (
    <aside className="member-list" aria-label="Virtual guild members">
      <div className="member-list-heading">Sample members — {members.length}</div>
      {sections.map(({ label, members: sectionMembers }) => (
        <section className="member-section" key={label}>
          <h2>
            {label} — {sectionMembers.length}
          </h2>
          <ul>
            {sectionMembers.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
