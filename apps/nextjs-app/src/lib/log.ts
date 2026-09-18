/** Minimal structured (JSON lines) logger. LOG_LEVEL=debug enables debug lines. */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level: Level): boolean {
  const min = process.env.LOG_LEVEL === "debug" ? "debug" : "info";
  return order[level] >= order[min];
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (!enabled(level)) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

/** Serialises an unknown error without leaking stack traces into responses. */
export function errorSummary(err: unknown): Fields {
  if (err instanceof Error) {
    const cause = err.cause as { code?: string; message?: string } | undefined;
    const detail = cause?.code ?? cause?.message; // e.g. ECONNREFUSED / ENOTFOUND behind "fetch failed"
    const code = (err as { code?: unknown }).code; // openid-client / oauth4webapi error codes
    return { error: err.name, message: err.message, ...(typeof code === "string" ? { code } : {}), ...(detail ? { cause: detail } : {}) };
  }
  return { error: String(err) };
}

type Who = { sub: string; roles: string[] } | null | undefined;

/** One line per request: method, path, status, duration and — when authenticated — sub and roles. */
export function logRequest(req: { method: string; nextUrl: { pathname: string } }, status: number, startedAt: number, who?: Who): void {
  requestLine({ method: req.method, path: req.nextUrl.pathname, status, durationMs: Date.now() - startedAt }, who);
}

/** The same line for pages (Server Components have no request object; page requests are always GET). */
export function logPage(path: string, status: number, who?: Who): void {
  requestLine({ method: "GET", path, status }, who);
}

function requestLine(fields: Fields, who: Who): void {
  log.info("request", { ...fields, ...(who ? { sub: who.sub, roles: who.roles } : {}) });
}
