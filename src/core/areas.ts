import type { State } from './model.js';

export function isAdminDiscussion(description: string): boolean {
  return /adm/i.test(description);
}

/** Hide provider-marked administrative areas without deleting subscriptions or downloaded mail. */
export function visibleDiscussions<T extends Pick<State, 'areas' | 'discussions'>>(state: T): T {
  const descriptions = new Map(state.areas.map((area) => [area.tag, area.name]));
  for (const area of state.discussions.entries)
    if (area.name !== area.tag || !descriptions.has(area.tag))
      descriptions.set(area.tag, area.name);
  const hidden = new Set(
    [...descriptions].filter(([, name]) => isAdminDiscussion(name)).map(([tag]) => tag),
  );
  return {
    ...state,
    areas: state.areas
      .filter((area) => !hidden.has(area.tag))
      .map((area) => ({ ...area, name: descriptions.get(area.tag) || area.name })),
    discussions: {
      ...state.discussions,
      entries: state.discussions.entries.filter((area) => !hidden.has(area.tag)),
    },
  };
}
