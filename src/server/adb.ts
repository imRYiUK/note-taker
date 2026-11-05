import type { AdbDevice } from "../shared/protocol.ts";

export interface ParsedDevice {
  serial: string;
  state: string;
  model: string | null;
}

/** Parse the output of `adb devices -l`. */
export function parseAdbDevices(out: string): ParsedDevice[] {
  const devices: ParsedDevice[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const modelTok = rest.find((t) => t.startsWith("model:"));
    devices.push({
      serial,
      state,
      model: modelTok ? modelTok.slice("model:".length).replaceAll("_", " ") : null,
    });
  }
  return devices;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<RunResult | null> {
  try {
    const proc = Bun.spawn(["adb", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch {
    return null; // adb not installed
  }
}

/**
 * Polls `adb devices`, keeps `adb reverse tcp:PORT tcp:PORT` in place for every
 * authorized device, and reports changes. This is what makes USB "just work".
 */
export class AdbWatcher {
  devices: AdbDevice[] = [];
  available = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastKey = "";

  constructor(
    private readonly getPort: () => number,
    private readonly onChange: (w: AdbWatcher) => void,
    private readonly log: (msg: string) => void = () => {},
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.tick().catch((e) => this.log(`adb: ${e}`));
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.available ? this.intervalMs : 15000);
  }

  async tick(): Promise<void> {
    const res = await run(["devices", "-l"]);
    if (!res || res.code !== 0) {
      this.setDevices([], false);
      return;
    }

    const parsed = parseAdbDevices(res.stdout);
    const next: AdbDevice[] = [];
    for (const d of parsed) {
      let reversed = false;
      if (d.state === "device") {
        reversed = await this.ensureReverse(d.serial);
      }
      next.push({ ...d, reversed });
    }
    this.setDevices(next, true);
  }

  private async ensureReverse(serial: string): Promise<boolean> {
    const spec = `tcp:${this.getPort()}`;
    const list = await run(["-s", serial, "reverse", "--list"]);
    if (list?.code === 0 && list.stdout.includes(`${spec} ${spec}`)) return true;

    const res = await run(["-s", serial, "reverse", spec, spec]);
    const ok = res?.code === 0;
    this.log(ok ? `adb: reverse ${spec} set up for ${serial}` : `adb: reverse failed for ${serial}: ${res?.stderr.trim()}`);
    return ok;
  }

  private setDevices(devices: AdbDevice[], available: boolean): void {
    const key = JSON.stringify([available, devices]);
    this.devices = devices;
    this.available = available;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.onChange(this);
    }
  }

  /** Open a URL in Chrome on the phone. */
  async openUrl(serial: string, url: string): Promise<boolean> {
    // `adb shell` re-parses on the device, so quote the URL ('?' and '&' are special).
    const quoted = `'${url.replaceAll("'", "")}'`;
    const base = ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", quoted];
    const chrome = await run([...base, "com.android.chrome"]);
    if (chrome?.code === 0 && !/Error/.test(chrome.stdout + chrome.stderr)) return true;
    const any = await run(base);
    return any?.code === 0 && !/Error/.test(any.stdout + any.stderr);
  }
}
