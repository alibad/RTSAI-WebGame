// Local/model and mock controls belong only to an explicitly enabled developer build.
export const companionDeveloperTools = import.meta.env.DEV && import.meta.env.VITE_COMPANION_DEV_TOOLS === "1";
