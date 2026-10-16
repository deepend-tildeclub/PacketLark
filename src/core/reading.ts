import type { ReadingSettings, Message } from './model.js';
export const defaultReading: ReadingSettings = {
  fontSize: 14,
  font: 'system',
  density: 'comfortable',
  collapseRead: false,
  collapseQuotes: false,
  collapseSignatures: false,
};
export type BodyBlock = { kind: 'text' | 'quote' | 'signature'; text: string };

/** Keep every byte of display text, including line endings, when folding sections. */
export function bodyBlocks(body: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  let signature = false;
  for (const line of body.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    const content = line.replace(/\r?\n$/, '');
    if (/^(?:-- $|---(?: |$)| \* Origin:)/.test(content)) signature = true;
    const kind = signature
      ? 'signature'
      : /^\s*(?:[A-Za-z0-9_.-]{1,8}\s*)?>/.test(content)
        ? 'quote'
        : 'text';
    const previous = blocks.at(-1);
    if (previous?.kind === kind) previous.text += line;
    else blocks.push({ kind, text: line });
  }
  return blocks;
}
export function firstUnread(messages: readonly Message[]): Message | undefined {
  let first: Message | undefined;
  for (const m of messages) {
    if (m.folder !== 'inbox' || m.read || m.internal) continue;
    const time = Date.parse(m.date),
      previous = first ? Date.parse(first.date) : NaN;
    if (!first || (!Number.isNaN(time) && (Number.isNaN(previous) || time < previous))) first = m;
  }
  return first;
}
