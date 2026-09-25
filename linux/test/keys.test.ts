import { expect, test } from "bun:test";
import { KeyWatcher, listKeyboards } from "../src/keys";

const devices = `I: Bus=0003 Vendor=29ea Product=0362 Version=0111
N: Name="Kinesis Corporation Adv360 Pro Keyboard"
H: Handlers=sysrq kbd event265 leds
B: EV=12001b
B: KEY=33e40 0 0 808003072fd025 bf84444200000000 1 13007300138000 43fa00404c00 e0beffdf01cfffff fffffffffffffffe

I: Bus=0006 Vendor=4b49 Product=4e45 Version=0001
N: Name="Kinesis air cursor"
H: Handlers=mouse23 event267
B: EV=7
B: KEY=70000 0 0 0 0

I: Bus=0006 Vendor=0000 Product=0000 Version=0000
N: Name="ydotoold virtual device"
H: Handlers=sysrq kbd event24
B: EV=120007
B: KEY=ffffffffffffffff fffffffffffffffe

I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
H: Handlers=kbd event2
B: EV=3
B: KEY=10000000000000 0
`;

test("keyboards are the real ones with an Escape key, not the injecting or pointer devices", () => {
  expect(listKeyboards(devices)).toEqual([{ node: "event265", name: "Kinesis Corporation Adv360 Pro Keyboard" }]);
});

test("the watcher reports Escape presses and whether either Alt is held", () => {
  const seen: string[] = [];
  const watcher = new KeyWatcher({ onEscape: () => seen.push("escape"), onAlt: (held) => seen.push(`alt ${held}`) }, () => []);
  const key = (node: string, code: number, value: number) => watcher.key(node, code, value);
  key("event1", 56, 1); // left Alt down
  key("event1", 100, 1); // right Alt down too: still held
  key("event1", 56, 0);
  key("event1", 100, 2); // autorepeat
  key("event1", 100, 0);
  key("event1", 1, 1); // Escape
  key("event1", 1, 2); // its autorepeat is not another press
  key("event1", 30, 1); // any other key is ignored
  expect(seen).toEqual(["alt true", "alt false", "escape"]);
});
