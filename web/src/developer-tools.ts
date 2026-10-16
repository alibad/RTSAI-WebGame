/** Diagnostics are available only in an explicitly opted-in development build. */
export const developerTools = import.meta.env.DEV && import.meta.env.VITE_DEVELOPER_TOOLS === "1";
