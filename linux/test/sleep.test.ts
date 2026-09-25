import { expect, test } from "bun:test";
import { parsePrepareForSleep } from "../src/sleep";

test("reads logind's PrepareForSleep from gdbus monitor output", () => {
  expect(parsePrepareForSleep("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)")).toBe(true);
  expect(parsePrepareForSleep("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)")).toBe(false);
  expect(parsePrepareForSleep("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (true,)")).toBeUndefined();
  expect(parsePrepareForSleep("Monitoring signals on object /org/freedesktop/login1 owned by :1.3")).toBeUndefined();
});
