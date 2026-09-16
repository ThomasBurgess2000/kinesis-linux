# kinesis for linux

use your meta neural band to control a linux desktop. same protocol and gesture rules as the mac app, running on bun with bluez.

- **transport**: bluez over d-bus (`busctl`) for discovery, the psm characteristic, pairing, and battery; a raw le l2cap socket for the encrypted input stream. no root, no kernel patches.
- **crypto**: the airshield handshake and packet authentication are a direct port of `Sources/KinesisCore`, checked against the same test vectors and synthetic-peer tests.
- **actions**: on kde plasma, global shortcuts are invoked over d-bus, which works on wayland without input injection. escape and tab switching go through `ydotool`. any action can be replaced with your own command, so other desktops work too.

## requirements

- linux with bluez 5.5x+ (`bluetoothd` running) and a bluetooth le adapter
- bun 1.2+
- for the built-in kde backend: plasma 6 with `qdbus6` (package `qt6-tools` or `qdbus-qt6`); optionally `ydotool` with `ydotoold` running for the escape and tab actions
- for other desktops: `xdotool`, `ydotool`, `wtype`, or any command you want to map

## run it

**unpair the band from the meta ai app first**, then put it in pairing mode.

```sh
cd linux
bun install
bun run src/cli.ts doctor      # checks bluetooth, tools, and permissions
bun run src/cli.ts scan        # finds the band and remembers it
bun run src/cli.ts run         # connects, enables controls, and reconnects if the link drops
```

`run --practice` connects and prints gestures without sending anything to the desktop. `run --verbose` logs the bluetooth steps. ctrl-c disables the band's streams cleanly before exiting.

to install as a command: `bun link` in `linux/`, then `kinesis run`.

## controls

the initial mappings match the mac app:

| gesture | action |
| --- | --- |
| thumb swipe left / right | previous / next desktop |
| thumb swipe up | overview |
| thumb swipe down | dismiss (escape) |
| index double tap | play / pause |
| middle double tap | mute / unmute |
| index or middle single tap | unassigned |
| pinch thumb + index, then turn your wrist | volume |

change them with `kinesis config`:

```sh
kinesis actions                                  # every action and whether your backend supports it
kinesis config set swipes.up launcher
kinesis config set taps.indexTap showDesktop
kinesis config set dial.target brightness
kinesis config set dial.sensitivity 2
kinesis actions --test nextDesktop               # try one without the band
```

actions: `previousDesktop`, `nextDesktop`, `overview`, `showDesktop`, `dismiss`, `previousWindow`, `nextWindow`, `previousTab`, `nextTab`, `playPause`, `nextTrack`, `previousTrack`, `mute`, `volumeUp`, `volumeDown`, `brightnessUp`, `brightnessDown`, `launcher`, `none`.

### other desktops

set `backend` to `command` and map actions to argv arrays. overrides also work alongside the kde backend for individual actions.

```sh
kinesis config set backend command
kinesis config set commands.previousDesktop '["xdotool","key","ctrl+alt+Left"]'
kinesis config set commands.volumeUp '["wpctl","set-volume","@DEFAULT_AUDIO_SINK@","5%+"]'
kinesis config set commands.playPause '["playerctl","play-pause"]'
```

settings live in `~/.config/kinesis/config.json` (`kinesis config path`).

## handedness

the band's own hand setting is read on every connect and the wrist dial is mirrored for the left hand, as in the mac app. to change it on the band:

```sh
kinesis hand left
```

## pairing

the tested firmware accepts a fresh encrypted session without a bluetooth bond, and `run` connects without pairing. if your band answers the psm read with an authentication error, `run` pairs through bluez automatically; `kinesis pair` does it explicitly. plasma's bluetooth agent will show a prompt if the band asks for confirmation. set `security` to `medium` if the l2cap channel itself refuses an unencrypted link.

`kinesis forget` drops the saved band and removes it from bluez.

## how it works

- `src/wire.ts`, `src/airshield.ts`, `src/session.ts`, `src/dial.ts`, `src/gestures.ts` — the protocol and gesture core, ported one to one from the swift sources. transport agnostic.
- `src/bluez.ts` + `src/dbus-text.ts` — bluez through `busctl`, parsing its typed text output (busctl's json mode can't serialise the `a{qv}` manufacturer data that phones advertise).
- `src/l2cap.ts` + `src/l2cap-worker.ts` — `AF_BLUETOOTH` seqpacket socket through `bun:ffi`. reads block in a worker thread and are posted to the main thread; writes go straight to the descriptor.
- `src/connection.ts` — one band connection: bluez connect, psm read, l2cap open, handshake, subscription, status queries when quiet, clean shutdown with the disable acknowledgement.
- `src/controller.ts` — the mac app's model without the ui: gating, de-duplication, dial steps, reconnect with backoff.
- `src/actions.ts` — kde and command backends.

`bun test` runs the protocol vectors, the synthetic encrypted peer, gesture routing, the busctl parser, a socketpair loopback of the worker, and the controller.

## limits

- verified against firmware `297b870dc9be+` through the mac and poc work; the linux transport was tested with a loopback peer and a real bluez scan, and needs a band in hand to confirm the l2cap open and handshake end to end. `run --verbose` shows each step.
- the l2cap receive mtu is requested at 8 kib; kernels that reject setting it before connect keep their default, which still carries the band's frames.
- previous/next window use kwin's walk-through shortcuts, which switch immediately when invoked over d-bus.
- brightness uses powerdevil, so external displays without ddc support won't respond.
- no raw semg. see [neural-band-poc](https://github.com/callbacked/neural-band-poc) for that.
