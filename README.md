# Kinesis for Linux

<img width="1006" height="749" alt="Screenshot_20260925_184016" src="https://github.com/user-attachments/assets/6a8c081d-a97d-4316-8227-6ef0132d525e" />

Use your Meta Neural Band to control a Linux desktop: swipe between desktops, open the overview,
control your music, pinch and turn for volume or brightness, and (experimentally) move the pointer
with your forearm. It's a tray icon and a Kirigami window for KDE Plasma, with the band in a
background service.

This is a Linux port of [callbacked/kinesis](https://github.com/callbacked/kinesis), the macOS app,
which grew out of [neural-band-poc](https://github.com/callbacked/neural-band-poc). It speaks the same
protocol with the same gesture rules, rewritten for Bun and BlueZ. The Mac app's sources are still
here (`Sources/`, `Packaging/`, `scripts/`), kept in step with upstream; the Linux port lives in
[`linux/`](linux/).

Everything is experimental. Some things may act quirky or not work at all.

- **Transport**: BlueZ over D-Bus (`busctl`) for discovery, the PSM characteristic, pairing, and battery; a raw LE L2CAP socket for the encrypted input stream. No root. Linux kernels before 7.2 need one Bluetooth patch for sessions longer than about 40 s (see [Kernel](#kernel)).
- **Crypto**: the AirShield handshake and packet authentication are a direct port of `Sources/KinesisCore`, checked against the same test vectors and synthetic-peer tests.
- **Actions**: on KDE Plasma, global shortcuts are invoked over D-Bus, which works on Wayland without input injection. Escape and tab switching go through `ydotool`. Any action can be replaced with your own command, so other desktops work too.

## Requirements

- Linux with BlueZ 5.5x or later (`bluetoothd` running) and a Bluetooth LE adapter
- Bun 1.2 or later
- For the built-in KDE backend: Plasma 6 with `qdbus6` (package `qt6-tools` or `qdbus-qt6`); optionally `ydotool` with `ydotoold` running for the Escape and tab actions
- For other desktops: `xdotool`, `ydotool`, `wtype`, or any command you want to map
- For the app (tray icon and window): PySide6 with its QML modules, and Kirigami and Kirigami Addons (installed with Plasma):
  `sudo apt install python3-pyside6.qtqml python3-pyside6.qtquick python3-pyside6.qtnetwork qml6-module-qtquick3d`
- For the air cursor: membership of the `input` group (see [Air cursor](#air-cursor))

## The app

A tray icon and a Kirigami window, like the Mac app's menu bar and main window. The band lives in a
background service (`kinesis daemon`, the `kinesis.service` user unit); the window only draws it, so
closing or restarting the window never drops the band.

```sh
cd linux
bun install
packaging/install.sh              # user unit, launcher, and login autostart, then opens Kinesis
packaging/install.sh --uninstall  # removes them again (pairing and settings are kept)
```

**Unpair the band from the Meta AI app first.** The first launch runs a quick setup: pair the band
(put it in pairing mode, sign in with Meta once, claim the band), pick your wrist, try a swipe, try
pinch and turn on a practice dial, then a summary with a test action. After that the window has:

- **Band column**: status, battery, gesture count, and the one next step (pair, connect, enable or pause controls)
- **Overview**: a 3D hand that mirrors the band (it lights the fingertips of each gesture, acts it out, holds a pinch as long as you do, and turns with your wrist on the dial, inside the band's ring of electrodes), what the gesture did, and your assignments
- **Gestures**: an action for each swipe and tap, and the pinch dial's target and sensitivity. Changes apply immediately
- **Band**: wrist, start automatically, start at login, Meta account, diagnostics with a test action, forget this band, and developer mode
- **Readings** (developer mode): live raw sEMG on all eight channels, raw recording as JSONL, and the band's motion: gyro traces, where the forearm points, sample rates, and arrival delay
- **Cursor** (developer mode): the experimental [air cursor](#air-cursor)

The tray menu has the status, battery, the next step, disconnect, the air cursor (developer mode),
open, and quit. Closing the window keeps Kinesis in the tray; **Quit** stops the service too, which
disconnects the band. The command line still works for scripting; `run`, `hand` and `enroll` refuse
while the service holds the band (`systemctl --user stop kinesis.service` first).

`python3 linux/ui/kinesis-ui.py --check [--screenshots DIR]` renders every page and setup step
offscreen against canned data and fails on any QML warning (no band or service needed).

The service speaks newline-delimited JSON on `$XDG_RUNTIME_DIR/kinesis/daemon.sock` (mode 0600):
requests `{id, method, params}`, replies `{id, result|error}`, and pushed `{event, data}` for state,
config, gesture, action, dial, pairing, log, emg, and motion. See `linux/src/daemon.ts`.

## Command line

```sh
cd linux
bun install
bun run src/cli.ts doctor      # checks Bluetooth, tools, permissions, and the kernel patch
bun run src/cli.ts scan        # finds the band and remembers it
bun run src/cli.ts enroll      # claims the band to your Meta account (once)
bun run src/cli.ts run         # connects, enables controls, and reconnects if the link drops
```

`kinesis inspect` prints everything distinct the band has sent besides sensor data, decoded field
by field: its device info, configuration, stream state, battery, and any message the port doesn't
otherwise understand. The service records these as they arrive (only from requests it already
makes; nothing extra is sent to the band) in `~/.local/state/kinesis/band-records.json`. Field names
come from what [neural-band-poc](https://github.com/callbacked/neural-band-poc) recovered from the
phone app; unnamed fields show by number. This is how undocumented settings, such as a haptics
switch, might be found. What one band reported so far, and what's still unidentified, is in
[linux/docs/band-records.md](linux/docs/band-records.md).

`run --practice` connects and prints gestures without sending anything to the desktop. `run --verbose`
logs the Bluetooth steps. Ctrl-C disables the band's streams cleanly before exiting. To install it as
a command, run `bun link` in `linux/`, then `kinesis run`.

## Enrollment

The band gates its sensor stream to whichever key it was enrolled with (`0xc001` without it).
`kinesis enroll` (or pairing in the app) claims the band to your Meta account and stores a signing
key locally, so every later session proves ownership with a per-session trust handshake, the same
thing the phone app does. You sign in on Meta's own page in your browser; a temporary handler for the
`oculus://` and `fb-viewapp://` callbacks captures the result (the CLI falls back to pasting it). This
client never sees your password, only the returned blob. The key lives in
`~/.local/state/kinesis/identity/` and the Meta session in `~/.local/state/kinesis/meta-session.json`.
See [linux/docs/findings.md](linux/docs/findings.md) for how the protocol was worked out.

## Controls

The initial mappings match the Mac app:

| Gesture | Action |
| --- | --- |
| Thumb swipe left / right | Previous / next desktop |
| Thumb swipe up | Overview |
| Thumb swipe down | Dismiss (Escape) |
| Index double tap | Play / pause |
| Middle double tap | Mute / unmute |
| Middle hold | Unassigned |
| Index or middle single tap | Unassigned |
| Pinch thumb and index, then turn your wrist | Volume |

Change them on the app's Gestures page, or with `kinesis config`:

```sh
kinesis actions                                  # every action and whether your backend supports it
kinesis config set swipes.up launcher
kinesis config set taps.indexTap showDesktop
kinesis config set dial.target brightness
kinesis config set dial.sensitivity 2
kinesis actions --test nextDesktop               # try one without the band
```

Actions: `previousDesktop`, `nextDesktop`, `overview`, `showDesktop`, `dismiss`, `previousWindow`, `nextWindow`, `previousTab`, `nextTab`, `playPause`, `nextTrack`, `previousTrack`, `mute`, `volumeUp`, `volumeDown`, `brightnessUp`, `brightnessDown`, `launcher`, `none`.

### Other desktops

Set `backend` to `command` and map actions to argv arrays. Overrides also work alongside the KDE backend for individual actions.

```sh
kinesis config set backend command
kinesis config set commands.previousDesktop '["xdotool","key","ctrl+alt+Left"]'
kinesis config set commands.volumeUp '["wpctl","set-volume","@DEFAULT_AUDIO_SINK@","5%+"]'
kinesis config set commands.playPause '["playerctl","play-pause"]'
```

Settings live in `~/.config/kinesis/config.json` (`kinesis config path`).

## Air cursor

Experimental, as on the Mac: turn on developer mode (Band page), then use the Cursor page or the tray.
Move your forearm to move the pointer, like a mouse. Pinch your index finger to click, hold the pinch
to drag, and pinch your middle finger to right-click. Thumb swipes keep their actions. Escape turns
it off; hold Alt to move your arm without moving the pointer.

It's a port of upstream's pointer model (`linux/src/air-cursor.ts`, from `AirCursor.swift` and its
[notes](docs/cursor-orientation.md)). The band's orientation quaternion says where the forearm points
and the gyro how fast it turns, so a wrist twist never moves the pointer. A 1€ filter and a
stillness threshold hold the pointer still when your arm is. Slow aiming gets 0.6× and flicks up to
the flick boost. A pinch's drift is absorbed. Movement plays back 30 ms behind the arm so it's
smooth, and a gentle pull toward where the arm started keeps pointer and arm from walking apart. The
three levers on the Cursor page are speed (points per degree), flick boost, and steadiness; they're
also settable with `kinesis config set cursor.speed 50` and so on.

On Linux the pointer is a virtual mouse the service makes with uinput, set to a flat acceleration
profile through KWin, so clicks land wherever the pointer is. Escape and Alt are read from your
keyboards' evdev nodes (passively, only those keys, only while the cursor is on), since Wayland has
no global key monitor. Both need the `input` group:

```sh
sudo usermod -aG input $USER    # then log out and back in
```

`kinesis doctor` shows whether both work. The orientation stream only runs while the cursor, the
Readings page, or the Cursor page needs it; upstream found the link congested with it always on.
`KINESIS_MOTION_LOG=/path/motion.jsonl` makes the service log every gyro, orientation, and gesture
event with both clocks. Upstream's calibration and practice lab are lab-build tools and aren't ported.

## Handedness

The band's own hand setting is read on every connect, and the wrist dial is mirrored for the left
hand, as in the Mac app. Change it in the app, or on the band with `kinesis hand left`.

## Pairing and reconnecting

The service connects through BlueZ. The first connection after pairing mode asks to pair: Plasma
shows a Bluetooth pairing request, and the band only opens its input channel once it's accepted.
`kinesis forget` drops the saved band and removes it from BlueZ.

### Unsolved: reconnecting to a paired band

**This isn't solved yet, and I'd really appreciate help with it.** If you know BlueZ, LE bonding, or
this band, please [open an issue](https://github.com/ThomasBurgess2000/kinesis-linux/issues) or a pull
request.

After a restart, a resume, or a dropped link, reconnecting to the already-paired (bonded) band is
unreliable. BlueZ sees the band advertising, but its connect times out after 18 s, again and again.
Once it took 15 attempts and about 7 minutes before one got through; other times the bond was
removed before any attempt succeeded.

What's known so far:

- **Bonded, through BlueZ's connect** (the default): repeated `Connection timed out`, often for
  minutes.
- **Unbonded, through BlueZ's connect**: connects within about a minute of a button press, but the
  band asks to pair while its settings are read, and accepting the request bonds it again, so the
  next reconnect has the same problem.
- **Unbonded, direct L2CAP** (`kinesis config set directL2cap true`, PSM 255): the band refuses the
  channel (`Connection refused`) or times out on every attempt, even right after a button press.
- The session protocol itself isn't involved: every failure happens before the first byte of it.

Until it's fixed, the dependable way back in is to remove the bond and pair fresh:

```sh
bluetoothctl remove <band address>    # the address is in `kinesis doctor`
```

Then press the band's button and accept the pairing request. The most useful next step would be a
`sudo btmon` capture of a slow bonded reconnect, to see whether the band never answers or BlueZ
connects with a stale address or keys.

## Kernel

Linux kernels before 7.2 leak an L2CAP signaling ident on every LE credit packet. After 254 credit
packets they're sent with the invalid ident 0, the band ignores them, and the stream stops, about
37 s into a full-rate session (sooner with a smaller socket buffer). `dmesg` shows `Bluetooth: Unable
to allocate ident: -28`. It's fixed upstream in
[6e1930ece855](https://github.com/torvalds/linux/commit/6e1930ece855). Until your distribution ships
it, [`linux/kernel-fix/`](linux/kernel-fix/) builds a patched `bluetooth.ko` for your running kernel
and swaps it in without a reboot:

```sh
cd linux
kernel-fix/build.sh                    # no root: fetches your kernel's source, patches, builds, verifies
sudo kernel-fix/install.sh             # installs to /lib/modules/<release>/updates and reloads bluetooth
sudo kernel-fix/uninstall.sh           # back to the stock module
```

Re-run both after a kernel update. `kinesis doctor` (and diagnostics in the app) report whether the
patched module is loaded.

## How it works

Everything below is under `linux/`.

- `src/wire.ts`, `src/airshield.ts`, `src/session.ts`, `src/dial.ts`, `src/gestures.ts`: the protocol and gesture core, ported one to one from the Swift sources. Transport agnostic.
- `src/ceremony.ts`, `src/identity.ts`, `src/meta-auth.ts`, `src/meta-pair.ts`, `src/enroll.ts`: band enrollment, meaning the ownership ceremony, the persistent P-256 signing identity, the Meta account sign-in, and the hardware-graph pairing calls.
- `src/bluez.ts` and `src/dbus-text.ts`: BlueZ through `busctl`, parsing its typed text output (busctl's JSON mode can't serialize the `a{qv}` manufacturer data that phones advertise).
- `src/l2cap.ts` and `src/l2cap-worker.ts`: the `AF_BLUETOOTH` seqpacket socket through `bun:ffi`. Reads block in a worker thread and are posted to the main thread; writes go straight to the descriptor.
- `src/connection.ts`: one band connection, from BlueZ connect, PSM read, L2CAP open, handshake, and subscription to status queries when quiet and a clean shutdown with the disable acknowledgement.
- `src/controller.ts`: the Mac app's model without the UI: gating, de-duplication, dial steps, the air cursor, late-data handling, and reconnect with backoff.
- `src/air-cursor.ts`, `src/uinput.ts`, `src/keys.ts`, `src/motion.ts`: the air cursor's pointer model, its virtual mouse, Escape and Alt, and motion readings.
- `src/daemon.ts`: the background service and its socket API. `src/actions.ts`: the KDE and command backends.
- `ui/`: the PySide6 launcher and tray (`kinesis-ui.py`) and the Kirigami window (`ui/qml/`), including the Qt Quick 3D hand (`ui/hand/`).
- `kernel-fix/`: the patched Bluetooth module. `packaging/`: the user unit, launcher, and autostart entry.

`bun test` (in `linux/`) runs the protocol vectors, the synthetic encrypted peer, gesture routing, the
air cursor's pointer model, the busctl parser, a socketpair loopback of the worker, the controller,
and the daemon.

## Limits

- **Enrollment is required for stable sessions**: an un-enrolled band drops the stream after about
  30 s (the `0xc001` owner gate). Enrollment talks to Meta's servers and needs a browser sign-in.
- The L2CAP receive MTU is requested at 8 KiB; kernels that reject setting it before connect keep their default, which still carries the band's frames.
- Previous and next window use KWin's walk-through shortcuts, which switch immediately when invoked over D-Bus.
- Brightness uses PowerDevil, so external displays without DDC support won't respond.
- Raw sEMG is for readings and recording only (developer mode); nothing is decoded from it.
- The air cursor can't see the pointer's real position (Wayland keeps it private), so its drift
  correction follows what it has moved itself. It has no calibration.

## License

MIT, as upstream: see [LICENSE](LICENSE). The 3D hand is the WebXR generic hand (MIT); see
[linux/ui/hand/](linux/ui/hand/).
