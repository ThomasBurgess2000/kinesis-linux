# kinesis for linux

use your meta neural band to control a linux desktop: swipe between desktops, open the overview,
control your music, pinch + turn for volume or brightness, and (experimentally) move the pointer
with your forearm. a tray icon and a kirigami window for kde plasma, with the band in a background
service.

this is a linux port of [callbacked/kinesis](https://github.com/callbacked/kinesis), the macos app,
which grew out of [neural-band-poc](https://github.com/callbacked/neural-band-poc). it speaks the same
protocol with the same gesture rules, rewritten for bun and bluez. the mac app's sources are still here
(`Sources/`, `Packaging/`, `scripts/`), kept in step with upstream; the linux port lives in
[`linux/`](linux/).

everything is experimental. some things may act quirky or not work at all.

- **transport**: bluez over d-bus (`busctl`) for discovery, the psm characteristic, pairing, and battery; a raw le l2cap socket for the encrypted input stream. no root. linux kernels before 7.2 need one bluetooth patch for sessions longer than ~40 s (see [kernel](#kernel)).
- **crypto**: the airshield handshake and packet authentication are a direct port of `Sources/KinesisCore`, checked against the same test vectors and synthetic-peer tests.
- **actions**: on kde plasma, global shortcuts are invoked over d-bus, which works on wayland without input injection. escape and tab switching go through `ydotool`. any action can be replaced with your own command, so other desktops work too.

## requirements

- linux with bluez 5.5x+ (`bluetoothd` running) and a bluetooth le adapter
- bun 1.2+
- for the built-in kde backend: plasma 6 with `qdbus6` (package `qt6-tools` or `qdbus-qt6`); optionally `ydotool` with `ydotoold` running for the escape and tab actions
- for other desktops: `xdotool`, `ydotool`, `wtype`, or any command you want to map
- for the app (tray icon + window): pyside6 with its qml modules, and kirigami + kirigami addons (installed with plasma):
  `sudo apt install python3-pyside6.qtqml python3-pyside6.qtquick python3-pyside6.qtnetwork qml6-module-qtquick3d`
- for the air cursor: membership of the `input` group (see [air cursor](#air-cursor))

## the app

a tray icon and a kirigami window, like the mac app's menu bar and main window. the band lives in a
background service (`kinesis daemon`, the `kinesis.service` user unit); the window only draws it, so
closing or restarting the window never drops the band.

```sh
cd linux
bun install
packaging/install.sh              # user unit + launcher + login autostart, then opens kinesis
packaging/install.sh --uninstall  # removes them again (pairing and settings are kept)
```

**unpair the band from the meta ai app first.** first launch runs a quick setup: pair the band (put
it in pairing mode, sign in with meta once, claim the band), pick your wrist, try a swipe, try pinch +
turn on a practice dial, then a summary with a test action. after that the window has:

- **band column**: status, battery, gesture count, and the one next step (pair, connect, enable or pause controls)
- **overview**: a 3d hand that mirrors the band (it lights the fingertips of each gesture, acts it out, holds a pinch as long as you do, and turns with your wrist on the dial, inside the band's ring of electrodes), what the gesture did, and your assignments
- **gestures**: an action for each swipe and tap, and the pinch dial's target and sensitivity. changes apply immediately
- **band**: wrist, start automatically, start at login, meta account, diagnostics with a test action, forget this band, and developer mode
- **readings** (developer mode): live raw semg on all eight channels, raw recording as jsonl, and the band's motion: gyro traces, where the forearm points, sample rates, and arrival delay
- **cursor** (developer mode): the experimental [air cursor](#air-cursor)

the tray menu has the status, battery, the next step, disconnect, the air cursor (developer mode),
open, and quit. closing the window keeps kinesis in the tray; **quit** stops the service too, which
disconnects the band. the command line still works for scripting; `run`, `hand` and `enroll` refuse
while the service holds the band (`systemctl --user stop kinesis.service` first).

`python3 linux/ui/kinesis-ui.py --check [--screenshots DIR]` renders every page and setup step
offscreen against canned data and fails on any qml warning (no band or service needed).

the service speaks newline-delimited json on `$XDG_RUNTIME_DIR/kinesis/daemon.sock` (0600): requests
`{id, method, params}`, replies `{id, result|error}`, and pushed `{event, data}` for state, config,
gesture, action, dial, pairing, log, emg, and motion. see `linux/src/daemon.ts`.

## command line

```sh
cd linux
bun install
bun run src/cli.ts doctor      # checks bluetooth, tools, permissions, and the kernel patch
bun run src/cli.ts scan        # finds the band and remembers it
bun run src/cli.ts enroll      # claims the band to your meta account (once)
bun run src/cli.ts run         # connects, enables controls, and reconnects if the link drops
```

`run --practice` connects and prints gestures without sending anything to the desktop. `run --verbose`
logs the bluetooth steps. ctrl-c disables the band's streams cleanly before exiting. to install as a
command: `bun link` in `linux/`, then `kinesis run`.

## enrollment

the band gates its sensor stream to whichever key it was enrolled with (`0xc001` without it).
`kinesis enroll` (or pairing in the app) claims the band to your meta account and stores a signing
key locally, so every later session proves ownership with a per-session trust handshake — the same
thing the phone app does. you sign in on meta's own page in your browser; a temporary handler for the
`oculus://` / `fb-viewapp://` callback captures the result (the cli falls back to pasting it). this
client never sees your password, only the returned blob. the key lives in
`~/.local/state/kinesis/identity/` and the meta session in `~/.local/state/kinesis/meta-session.json`.
see [linux/docs/findings.md](linux/docs/findings.md) for how the protocol was worked out.

## controls

the initial mappings match the mac app:

| gesture | action |
| --- | --- |
| thumb swipe left / right | previous / next desktop |
| thumb swipe up | overview |
| thumb swipe down | dismiss (escape) |
| index double tap | play / pause |
| middle double tap | mute / unmute |
| middle hold | unassigned |
| index or middle single tap | unassigned |
| pinch thumb + index, then turn your wrist | volume |

change them in the app's gestures page, or with `kinesis config`:

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

## air cursor

experimental, as on the mac: turn on developer mode (band page), then the cursor page or the tray.
move your forearm to move the pointer, like a mouse. pinch your index to click, hold the pinch to
drag, pinch your middle finger to right-click. thumb swipes keep their actions. escape turns it off;
hold alt to move your arm without moving the pointer.

it's a port of upstream's pointer model (`linux/src/air-cursor.ts`, from `AirCursor.swift` and its
[notes](docs/cursor-orientation.md)): the band's orientation quaternion says where the forearm points
and the gyro how fast it turns; a wrist twist never moves the pointer; a 1€ filter and a stillness
threshold hold it still when your arm is; slow aiming gets 0.6× and flicks up to the flick boost; a
pinch's drift is absorbed; movement plays back 30 ms behind the arm so it's smooth; and a gentle pull
toward where the arm started keeps pointer and arm from walking apart. the three levers on the cursor
page are speed (points per degree), flick boost, and steadiness, also `kinesis config set
cursor.speed 50` and friends.

on linux the pointer is a virtual mouse the service makes with uinput, set to a flat acceleration
profile through kwin, so clicks land wherever the pointer is. escape and alt are read from your
keyboards' evdev nodes (passively, only those keys, only while the cursor is on), since wayland has
no global key monitor. both need the `input` group:

```sh
sudo usermod -aG input $USER    # then log out and back in
```

`kinesis doctor` shows whether both work. the orientation stream only runs while the cursor, the
readings page, or the cursor page needs it; upstream found the link congested with it always on.
`KINESIS_MOTION_LOG=/path/motion.jsonl` makes the service log every gyro, orientation, and gesture
event with both clocks. upstream's calibration and practice lab are lab-build tools and aren't ported.

## handedness

the band's own hand setting is read on every connect and the wrist dial is mirrored for the left
hand, as in the mac app. change it in the app, or on the band with `kinesis hand left`.

## pairing and reconnecting

the service connects through bluez. the first connection after pairing mode asks to pair: plasma
shows a bluetooth pairing request, and the band only opens its input channel once it's accepted.
`kinesis forget` drops the saved band and removes it from bluez.

**known issue: reconnecting to an already-paired band can be slow.** after a restart, a resume, or a
dropped link, bluez's connect to the bonded band can time out again and again for several minutes
before one gets through. the dependable way back in is to remove the bond and pair fresh:

```sh
bluetoothctl remove <band address>    # the address is in `kinesis doctor`
```

then press the band's button and accept the pairing request. the direct l2cap connect
(`kinesis config set directL2cap true`) skips bluez's connect, but current firmware refuses it from
an unbonded host.

## kernel

linux kernels before 7.2 leak an l2cap signaling ident on every le credit packet. after 254 credit
packets they're sent with the invalid ident 0, the band ignores them, and the stream stops — about
37 s into a full-rate session, sooner with a smaller socket buffer. `dmesg` shows `Bluetooth: Unable to
allocate ident: -28`. it's fixed upstream in
[6e1930ece855](https://github.com/torvalds/linux/commit/6e1930ece855); until your distribution ships
it, [`linux/kernel-fix/`](linux/kernel-fix/) builds a patched `bluetooth.ko` for your running kernel
and swaps it in without a reboot:

```sh
cd linux
kernel-fix/build.sh                    # no root: fetches your kernel's source, patches, builds, verifies
sudo kernel-fix/install.sh             # installs to /lib/modules/<release>/updates and reloads bluetooth
sudo kernel-fix/uninstall.sh           # back to the stock module
```

re-run both after a kernel update. `kinesis doctor` (and diagnostics in the app) report whether the
patched module is loaded.

## how it works

everything below is under `linux/`.

- `src/wire.ts`, `src/airshield.ts`, `src/session.ts`, `src/dial.ts`, `src/gestures.ts` — the protocol and gesture core, ported one to one from the swift sources. transport agnostic.
- `src/ceremony.ts`, `src/identity.ts`, `src/meta-auth.ts`, `src/meta-pair.ts`, `src/enroll.ts` — band enrollment: the ownership ceremony, the persistent p-256 signing identity, the meta account sign-in, and the hardware-graph pairing calls.
- `src/bluez.ts` + `src/dbus-text.ts` — bluez through `busctl`, parsing its typed text output (busctl's json mode can't serialise the `a{qv}` manufacturer data that phones advertise).
- `src/l2cap.ts` + `src/l2cap-worker.ts` — `AF_BLUETOOTH` seqpacket socket through `bun:ffi`. reads block in a worker thread and are posted to the main thread; writes go straight to the descriptor.
- `src/connection.ts` — one band connection: bluez connect, psm read, l2cap open, handshake, subscription, status queries when quiet, clean shutdown with the disable acknowledgement.
- `src/controller.ts` — the mac app's model without the ui: gating, de-duplication, dial steps, the air cursor, late-data handling, reconnect with backoff.
- `src/air-cursor.ts`, `src/uinput.ts`, `src/keys.ts`, `src/motion.ts` — the air cursor's pointer model, its virtual mouse, escape and alt, and motion readings.
- `src/daemon.ts` — the background service and its socket api. `src/actions.ts` — kde and command backends.
- `ui/` — the pyside6 launcher and tray (`kinesis-ui.py`) and the kirigami window (`ui/qml/`), including the qt quick 3d hand (`ui/hand/`).
- `kernel-fix/` — the patched bluetooth module. `packaging/` — the user unit, launcher, and autostart entry.

`bun test` (in `linux/`) runs the protocol vectors, the synthetic encrypted peer, gesture routing, the
air cursor's pointer model, the busctl parser, a socketpair loopback of the worker, the controller,
and the daemon.

## limits

- **enrollment required for stable sessions**: an un-enrolled band drops the stream after ~30 s
  (`0xc001` owner gate). enrollment talks to meta's servers and needs a browser sign-in.
- the l2cap receive mtu is requested at 8 kib; kernels that reject setting it before connect keep their default, which still carries the band's frames.
- previous/next window use kwin's walk-through shortcuts, which switch immediately when invoked over d-bus.
- brightness uses powerdevil, so external displays without ddc support won't respond.
- raw semg is readings and recording only (developer mode); nothing is decoded from it.
- the air cursor can't see the pointer's real position (wayland keeps it private), so its drift
  correction follows what it has moved itself. it has no calibration.

## license

mit, as upstream: see [LICENSE](LICENSE). the 3d hand is the webxr generic hand (mit), see
[linux/ui/hand/](linux/ui/hand/).
