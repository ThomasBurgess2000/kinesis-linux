import { $ } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canCaptureCallback, captureCallback } from "../src/callback";

test("captureCallback registers a handler, captures the URL, and cleans up", async () => {
  if (!canCaptureCallback()) return; // xdg-mime not installed
  const base = mkdtempSync(join(tmpdir(), "kinesis-cb-"));
  const prevState = process.env.XDG_STATE_HOME, prevData = process.env.XDG_DATA_HOME, prevConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = join(base, "state");
  process.env.XDG_DATA_HOME = join(base, "data");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  const target = "oculus://frl_login/?token=abcdef0123456789&blob=SGVsbG8%3D";
  try {
    const captured = await captureCallback(6000, async () => {
      // The default handler for the scheme is now ours; running its Exec is what xdg-open does.
      const desktop = join(process.env.XDG_DATA_HOME!, "applications", "kinesis-enroll-callback.desktop");
      const exec = (await Bun.file(desktop).text()).split("\n").find((l) => l.startsWith("Exec="))!.slice(5).replace(" %u", "");
      await $`${exec} ${target}`.quiet().nothrow();
    });
    expect(captured).toBe(target);
    // The desktop entry is removed after capture.
    expect(await Bun.file(join(process.env.XDG_DATA_HOME!, "applications", "kinesis-enroll-callback.desktop")).exists()).toBe(false);
  } finally {
    process.env.XDG_STATE_HOME = prevState;
    process.env.XDG_DATA_HOME = prevData;
    process.env.XDG_CONFIG_HOME = prevConfig;
  }
});
