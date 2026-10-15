/** Cameos can differ for the same actor between countries. */
export const iconKey = (actor: string, faction?: string) => faction ? `${faction}:${actor}` : actor;
