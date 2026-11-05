import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { DEFAULT_PORT } from "../shared/protocol.ts";

export interface Config {
  port: number;
  /** Required by clients that connect over the LAN (loopback / USB is trusted). */
  token: string;
}

export function configDir(): string {
  return (
    process.env.NOTE_TAKER_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "note-taker")
  );
}

export function dataDir(): string {
  return (
    process.env.NOTE_TAKER_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "note-taker")
  );
}

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

/** Load config.json, creating it (with a fresh token) on first run. */
export async function loadConfig(): Promise<Config> {
  const dir = configDir();
  const file = join(dir, "config.json");
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // first run or unreadable — regenerate below
  }

  const cfg: Config = {
    port: typeof stored.port === "number" ? stored.port : DEFAULT_PORT,
    token: typeof stored.token === "string" && stored.token.length >= 16 ? stored.token : newToken(),
  };

  if (cfg.port !== stored.port || cfg.token !== stored.token) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  }

  const envPort = Number(process.env.NOTE_TAKER_PORT);
  if (Number.isInteger(envPort) && envPort > 0) cfg.port = envPort;
  return cfg;
}
