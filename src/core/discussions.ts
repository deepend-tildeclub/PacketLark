import { areaSchema, sameAddress, type Message, type Profile } from './model.js';

type Entry = { tag: string; name: string };
export type AreaReply =
  | { kind: 'list'; subscription: 'unknown' | 'joined' | 'left'; entries: Entry[]; empty: boolean }
  | {
      kind: 'changes';
      changes: { tag: string; subscription: 'joined' | 'left' | null; error: string }[];
    }
  | { kind: 'error'; error: string };

export function managementTag(value: string): string {
  const tag = areaSchema.parse(value);
  // A leading minus would be interpreted as another AreaFix command prefix.
  if (tag.startsWith('-')) throw new Error('Discussion tags cannot start with a minus sign.');
  return tag;
}

/** Identify previously queued app requests when upgrading an existing mailbox. */
export function isAreaRequest(message: Message, profile: Profile): boolean {
  try {
    if (
      !['outbox', 'sent'].includes(message.folder) ||
      message.area ||
      message.to.trim().toLowerCase() !== 'areafix' ||
      !sameAddress(message.fromAddress, profile.address) ||
      !sameAddress(message.toAddress, profile.uplink.address) ||
      !profile.uplink.areaFixPassword ||
      message.subject !== profile.uplink.areaFixPassword
    )
      return false;
    const lines = message.body
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.at(-1) === '---') lines.pop();
    return (
      lines.length > 0 &&
      lines.every((line) => {
        if (['%LIST', '%QUERY', '%UNLINKED'].includes(line)) return true;
        if (!/^[+-]/.test(line)) return false;
        managementTag(line.slice(1));
        return true;
      })
    );
  } catch {
    return false;
  }
}

/** Parse SBBSecho replies only; ordinary netmail and public posts are never commands. */
export function parseAreaReply(message: Message, profile: Profile): AreaReply | null {
  try {
    if (
      message.folder !== 'inbox' ||
      message.area ||
      !sameAddress(message.fromAddress, profile.uplink.address) ||
      !sameAddress(message.toAddress, profile.address) ||
      !/^(SBBSecho|AreaFix)$/i.test(message.from.trim())
    )
      return null;
  } catch {
    return null;
  }
  const lines = message.body.split(/\r\n|\r|\n/);
  const end = lines.findIndex((line) => /^\s*---(?:\s|$)/.test(line));
  const body = (end < 0 ? lines : lines.slice(0, end)).filter((line) => !line.startsWith('\x01'));
  const title = message.subject.trim();
  const list = /^List of (Available|Connected|Unlinked) Areas$/i.exec(title);
  if (list) {
    const entries: Entry[] = [];
    for (const line of body) {
      const match = /^\s*([A-Z0-9_!.-]{1,60})(?:[ \t]+(.*))?\s*$/i.exec(line);
      if (!match || /^(None\.|Continued)$/i.test(match[1])) continue;
      try {
        managementTag(match[1].toUpperCase());
      } catch {
        continue;
      }
      entries.push({
        tag: match[1].toUpperCase(),
        name: (match[2]?.trim() || match[1]).slice(0, 200),
      });
    }
    const empty = body.some((line) => /^None\.\s*$/i.test(line.trim()));
    if (!entries.length && !empty)
      return {
        kind: 'error',
        error:
          'Your provider returned an unreadable discussion list. Try refreshing or contact your sysop.',
      };
    return {
      kind: 'list',
      subscription:
        list[1].toLowerCase() === 'connected'
          ? 'joined'
          : list[1].toLowerCase() === 'unlinked'
            ? 'left'
            : 'unknown',
      entries,
      empty,
    };
  }
  if (title !== 'Area Management Request') return null;
  const changes: Extract<AreaReply, { kind: 'changes' }>['changes'] = [];
  for (const line of body) {
    const match =
      /^([A-Z0-9_!.-]{1,60}) (added|already connected|removed|not connected|not found)\.\s*$/.exec(
        line.trim(),
      );
    if (!match) continue;
    try {
      managementTag(match[1]);
    } catch {
      continue;
    }
    changes.push({
      tag: match[1],
      subscription: /^(added|already connected)$/.test(match[2])
        ? 'joined'
        : /^(removed|not connected)$/.test(match[2])
          ? 'left'
          : null,
      error:
        match[2] === 'not found' ? 'The provider could not find or authorize this discussion.' : '',
    });
  }
  if (changes.length) return { kind: 'changes', changes };
  if (body.some((line) => /^Invalid Password\.\s*$/i.test(line.trim())))
    return {
      kind: 'error',
      error: 'The provider rejected the discussion-management password. Contact your sysop.',
    };
  if (body.some((line) => /Your node is not configured for AreaMgr/i.test(line)))
    return {
      kind: 'error',
      error: 'Discussion management is disabled for this point. Contact your sysop.',
    };
  return {
    kind: 'error',
    error:
      'Your provider could not confirm the subscription change. Refresh discussions to check its status.',
  };
}
