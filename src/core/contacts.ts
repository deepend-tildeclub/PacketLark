import { address, formatAddress, type Message } from './model.js';

type Contact = { name: string; address: string };
export function recipientSuggestions(
  saved: Contact[],
  messages: Message[],
  point: string,
): Contact[] {
  const self = address(point);
  const selfKey = formatAddress(self, true);
  const byAddress = new Map<string, Contact>();
  const include = (name: string, value: string, saved = false) => {
    if (
      !name.trim() ||
      name.length > 35 ||
      /[\x00-\x1f]/.test(name) ||
      (!saved && (/\x7f/.test(name) || /^all$/i.test(name.trim())))
    )
      return;
    try {
      const addr = address(value);
      const key = formatAddress(addr, true);
      if (addr.domain !== self.domain || (!saved && key === selfKey) || byAddress.has(key)) return;
      byAddress.set(key, { name, address: value });
    } catch {
      // Imported names and addresses are untrusted; skip incomplete entries.
    }
  };
  for (const c of saved) include(c.name, c.address, true);
  const recent = messages
    .filter((m) => !m.internal && (m.folder === 'inbox' || (m.folder === 'sent' && !m.area)))
    .map((m) => ({ m, stamp: Date.parse(m.date) || 0 }))
    .sort((a, b) => b.stamp - a.stamp)
    .slice(0, 500);
  for (const { m } of recent) {
    if (m.folder === 'inbox') include(m.from, m.fromAddress);
    else include(m.to, m.toAddress);
  }
  return [...byAddress.values()];
}
