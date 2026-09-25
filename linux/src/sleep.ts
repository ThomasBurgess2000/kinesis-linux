// Suspend and resume from systemd-logind (the Linux side of the Mac app's willSleep/didWake).
// logind broadcasts PrepareForSleep(true) just before suspend or hibernate and (false) after resume.

import type { Logger } from "./connection";

/// Watch logind's PrepareForSleep. Returns a function that stops watching.
export function watchSleep(onChange: (sleeping: boolean) => void, log: Logger): () => void {
  const gdbus = Bun.which("gdbus");
  if (!gdbus) {
    log.notice("gdbus not found; the band won't be disconnected around suspend");
    return () => {};
  }
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;

  const start = () => {
    proc = Bun.spawn([gdbus, "monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1"], {
      stdout: "pipe", stderr: "ignore",
    });
    const current = proc;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of current.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const sleeping = parsePrepareForSleep(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (sleeping !== undefined) onChange(sleeping);
        }
      }
      await current.exited;
      // The monitor shouldn't exit on its own; if it does, keep watching.
      if (!stopped) setTimeout(() => { if (!stopped) start(); }, 5000);
    })();
  };
  start();
  return () => {
    stopped = true;
    proc?.kill();
  };
}

/// `…/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)` → true.
export function parsePrepareForSleep(line: string): boolean | undefined {
  const match = /\.PrepareForSleep \((true|false),?\)/.exec(line);
  return match ? match[1] === "true" : undefined;
}
