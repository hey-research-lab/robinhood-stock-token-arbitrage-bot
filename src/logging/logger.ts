import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT_KEY = /private|secret|api[_-]?key|webhook|authorization/i;

let filePath: string | undefined;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEY.test(key) ? "[redacted]" : value;
  }
  return out;
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  if (filePath) {
    appendFileSync(filePath, `${line}\n`);
  }
}

export function configureLogger(opts: { filePath?: string }): void {
  closeLogger();
  const path = opts.filePath?.trim();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  filePath = path;
}

export function closeLogger(): void {
  filePath = undefined;
}

export function loggerFilePath(): string | undefined {
  return filePath;
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
