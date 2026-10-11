export function trustedLocalRequest(req, port, { requireOrigin = false } = {}) {
  const names = (req.rawHeaders ?? []).filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
  if (names.filter(name => name === "host").length !== 1 || names.filter(name => name === "origin").length > 1) return false;
  const address = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return !requireOrigin;
  return typeof origin === 'string' && origin === `http://${host}`;
}
