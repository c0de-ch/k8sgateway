/** Minimal structured (JSON lines) logger. Never log tokens or Authorization headers. */
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minLevel: Level = 'info'): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Logger that swallows everything — used by the tests. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
