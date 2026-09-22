// Capture the Meta sign-in's `fb-viewapp://frl_login…` callback on Linux. The browser hands
// that custom scheme to xdg-open, which otherwise pops an app chooser and hides the URL. We
// register a temporary xdg handler for the scheme that writes the URL to a file, wait for it,
// then restore whatever handler was there before. Falls back to pasting the URL by hand.

import { $ } from "bun";
import { chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEME = "x-scheme-handler/fb-viewapp";
const DESKTOP = "kinesis-enroll-callback.desktop";

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kinesis");
}
function applicationsDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "applications");
}

export function canCaptureCallback(): boolean {
  return Bun.which("xdg-mime") !== null;
}

/// Open a URL in the user's browser (best effort).
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = Bun.which("xdg-open");
  if (!opener) return false;
  const result = await $`${opener} ${url}`.quiet().nothrow();
  return result.exitCode === 0;
}

/// Register the temporary handler, run `body` (which triggers the sign-in), and resolve with the
/// captured callback URL, or undefined on timeout. Always restores the previous handler.
export async function captureCallback(timeoutMs: number, onReady: () => void | Promise<void>): Promise<string | undefined> {
  const dir = stateDir();
  const scriptPath = join(dir, "fb-viewapp-handler.sh");
  const callbackPath = join(dir, "enroll-callback.url");
  const desktopPath = join(applicationsDir(), DESKTOP);
  await mkdir(dir, { recursive: true });
  await mkdir(dirname(desktopPath), { recursive: true });
  await Bun.file(callbackPath).delete().catch(() => {});

  // The handler writes its URL argument to the callback file and exits.
  await Bun.write(scriptPath, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(callbackPath)}\n`);
  chmodSync(scriptPath, 0o755);
  await Bun.write(desktopPath, [
    "[Desktop Entry]", "Type=Application", "Name=Kinesis Enroll Callback",
    `Exec=${scriptPath} %u`, `MimeType=${SCHEME};`, "NoDisplay=true", "Terminal=false", "",
  ].join("\n"));

  const previous = (await $`xdg-mime query default ${SCHEME}`.quiet().nothrow().text()).trim();
  if (Bun.which("update-desktop-database")) await $`update-desktop-database ${applicationsDir()}`.quiet().nothrow();
  await $`xdg-mime default ${DESKTOP} ${SCHEME}`.quiet().nothrow();

  try {
    await onReady();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const file = Bun.file(callbackPath);
      if (await file.exists()) {
        const url = (await file.text()).trim();
        if (url) return url;
      }
      await Bun.sleep(500);
    }
    return undefined;
  } finally {
    // Restore the previous handler (or clear ours) and clean up.
    if (previous && previous !== DESKTOP) await $`xdg-mime default ${previous} ${SCHEME}`.quiet().nothrow();
    await Bun.file(desktopPath).delete().catch(() => {});
    await Bun.file(scriptPath).delete().catch(() => {});
    await Bun.file(callbackPath).delete().catch(() => {});
    if (Bun.which("update-desktop-database")) await $`update-desktop-database ${applicationsDir()}`.quiet().nothrow();
  }
}
