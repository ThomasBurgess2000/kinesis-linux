# Linux bring-up findings

Notes from bringing the Linux port up against real hardware. These are observations
from one band, not a protocol specification.

## Hardware under test

- Band advertised name `Meta Band XXXX`, BlueZ identity address `AA:BB:CC:00:11:22` (public).
- The advertising address is a rotating random address; after connecting, BlueZ exposes the
  public identity address on the same `Device1` object. `bluez.findDevice` matches by identity
  address, then object path, then unique advertised name, and the CLI rewrites the saved band to
  the identity address on first connect.
- The identity certificate returned by the empty identity query (channel 2, type `0x02003001`,
  1877 bytes) is a DER X.509 EC certificate whose subject names the hardware `Swiftlet-PS`.

## What works end to end on this hardware

1. BlueZ LE connect, service resolution, and the GATT PSM read (`2d41da7c-…` returns `ff 00`,
   PSM 255).
2. The raw LE L2CAP connection-oriented channel (send MTU 970, receive MTU 8192).
3. The full AirShield parameter-3 handshake: P-256 ECDH, `Kenc = HKDF(SHA256(S), salt=SHA256(H||C||R))`,
   `Kmac = Kenc`, AES-256-CBC with chained IVs, truncated HMAC-SHA256. Every packet the band
   sent authenticated and decrypted. The 1877-byte identity certificate and the EndLinkSetup
   acknowledgement both decoded cleanly.

## The blocker: a newer link-setup gate (0xc001)

After the handshake the band answers **every** input-service request with the terminal word
`0x0300c001`. The `0xc001` code is the pre-link-setup rejection the upstream
[neural-band-poc](https://github.com/callbacked/neural-band-poc) documents.

Our EndLinkSetup message is byte-for-byte identical to the Mac app's and the POC's working probe
(channel `0x8001`, type `0x02001000`, `field1=1` + a fresh 16-byte link UUID), and the band
acknowledges it. Yet the requests still fail, in both pipelined and phased ordering.

The band's own replies show why. In order, on the encrypted input stream:

| frame | channel | type | payload | meaning |
| --- | --- | --- | --- | --- |
| 0 | 2 | `0x02003001` | 1877 B cert | identity response (ok) |
| 1 | 1 | `0x02001000` | `08 01 12 10 <uuid16>` | EndLinkSetup ack, echoing our link UUID |
| 2 | 1 | `0x01000000` | empty | **unsolicited link-setup message from the band** |
| 3 | 3 | `0x0300c001` | empty | device-info rejected: link not set up |
| 4 | 5 | `0x0300c001` | empty | subscribe id 2 rejected |
| 5 | 5 | `0x0300c001` | empty | subscribe id 3 rejected |
| 6 | 6 | `0x0300c001` | empty | hand read rejected |

Frame 2 is the key. The band sends a `0x01000000` message that neither this port nor the Mac app
answers (the Mac app's `input()` only handles `0x02000315`, `0x0200020d`, `0x0200020f`,
`0x02000212`, and ignores everything else). On the POC's and the Mac author's older firmware,
ignoring it is fine and the subscription enables. On this `Swiftlet-PS` firmware, the input
service stays gated at `0xc001` until that step is completed.

Phased link setup (`linkSetup: phased`) was added and tested: it waits for frame 1 before sending
the `0xce56` requests, and the result is identical. So this is not a request-ordering problem; it
is a missing link-setup step. It matches the POC's own stated limit that full owner-identity
authentication was never established.

### What this means for the port

The Linux port reaches exact parity with the Mac app and the POC on the wire. On older firmware it
should subscribe and stream; on this newer firmware it stops at the same `0xc001` gate the Mac app
would. Getting past it requires reverse engineering the `0x01000000` link-setup / owner-auth step,
which is new protocol work beyond porting.

### Reproducing

`bun run scripts/probe.ts` connects once and dumps every decoded frame with its payload.
`PROBE_PHASED=1` and `PROBE_CONFIGCH=8007` vary the two knobs. `kinesis run --verbose` shows the
same frames inline during a normal session.

### Leads for the 0x01000000 step

- It arrives on channel 1 (the link-setup control channel), type `0x01000000`, empty payload.
- The `0x01xxxxxx` service prefix differs from the `0x02xxxxxx` used by encryption/identity/RPC,
  suggesting a relay or link-control service rather than the device RPC service.
- The POC's `atc.proto` names `link setup config = 3` and `end link setup = 0x1000`; a `0x01000000`
  reply type is unmapped in the public schema.
- The `EnableEncryption` message has optional fields `7 phased_link_setup_supported` and
  `8 supported_link_setup_services` that we do not currently send; declaring them may change the
  band's link-setup expectations. Worth trying next.

## Live experiment results (follow-ups do not clear 0xc001)

Ran `scripts/experiment.ts` against the band on a live connection (manual link setup, then
scripted follow-ups on the encrypted channel):

- Echoing the band's `0x01000000` message on channel 1 draws no reply and does not unlock anything.
- A second EndLinkSetup returns `0x0300c001` (the first one, during handshake, is acked normally).
- A `0x02000003` link-setup-config message returns `0x0300c001`.
- Subscribing on a fresh RPC channel (`0x8009`) returns `0x0300c001`, same as `0x8005`.

So no post-handshake message clears the gate; once the first EndLinkSetup is acked the band
refuses further link-setup control. The decision is made during encryption/link-setup negotiation,
not afterward.

The optional EnableEncryption fields 7 (`phased_link_setup_supported`) and 8
(`supported_link_setup_services`) are probably not the differentiator: the POC's phone-to-band
capture shows the phone does **not** send them, yet the phone reaches the input service. That
points at owner/authorization state rather than a missing negotiation field. The leading
hypothesis was that the band still had the Meta AI app registered as its owner.

## RESOLVED: it was owner state, not firmware

Confirmed on hardware. Unpairing the band in the Meta AI app while the band is **disconnected**
removes the app's record but does not tell the band, so the band keeps its owner state and gates
the input service at `0xc001`. Re-adding the band in the app, letting it connect, and removing it
**while connected** pushes the deregistration to the band. After that, a fresh AirShield session
from Linux is accepted in full:

- device-info returns firmware `297b870dc9be+` from "Meta Platforms, Inc." (the same firmware the
  POC tested, so this was never a newer-firmware wall),
- both subscription requests are acknowledged with flags 3/6/8 enabled,
- the hand read returns right, and the session reports Connected / streams enabled.

So the port works end to end. The `0xc001` was purely owner authorization; the fix is the
"unpair from the Meta app first" step done **with the band connected** so it actually registers.

Gestures and motion only stream while the band is **worn** (the sensors need skin contact); an
idle band on a desk sends only subscription-status frames and then drops the stream.

## BlueZ connection notes for this firmware

- The band's connectable window after a button press is short. Reliable path: scan until it
  advertises (RSSI present), `StopDiscovery`, wait for `Discovering=false`, then `Connect`.
  Connecting while discovery is active gives `le-connection-abort-by-local`.
- Bonding hurt reconnection here: once bonded, `Connect` to the identity address timed out while
  the band advertised a fresh resolvable-private address. Removing the bond and connecting fresh
  worked. The app should probably not pair unless the PSM read demands it.

## Definitive: the 0xc001 gate is not clearable client-side (even factory reset)

Tested every state:
- Immediately after a Meta-app deregistration ("re-add, then remove while connected"): the input
  service opened once — streams enabled with flags 3/6/8, hand read, device-info all succeeded.
- Every later session (unbonded, bonded, fresh pairing mode): `0x0300c001` on all input requests.
- After a full **factory reset** of the band: still `0x0300c001`. Handshake and decryption work;
  the input service stays gated.

Conclusion: the input-service gate is an authentication/activation requirement in this firmware,
not owner/bond state a client can clear. The single working run was a transient post-deregistration
window that is not reproducible on demand. Getting past it needs the owner-authentication step the
upstream POC also left unsolved — out of reach for a third-party client. The Linux transport,
handshake, decryption, and (in that one window) the full subscription are all proven; this gate is
the sole remaining blocker and it is on the band, not in this code.

## CONFIRMED WORKING END TO END (2026-09-17)

Correction to the section above: the gate is clearable, and the working recipe is reproducible.
A factory reset is the wrong move (it leaves the band un-activated and locked). The right one:

1. Set the band up fully in the Meta AI app (let it activate).
2. With the band still connected to the phone, remove/forget it in the app.
3. Connect from Linux in the window right after (`kinesis run`, scanner already waiting).

Result on real hardware: streams enabled, hand confirmed, and live gestures recognized and mapped:
index double tap -> play/pause, swipe left -> previous desktop, swipe right -> next desktop, with
~1000 gyro/orientation frames in a few seconds. The full Linux path works.

Remaining issue: the stream stopped after ~9 s of input and the band would not accept a reconnect
afterward, so the open window is short and the band re-locks. Keeping the session alive across
that is the next problem; the port itself is proven.

## Session length: band resets an unauthenticated peer at ~33-40 s (2026-09-17)

With the recipe working (press button -> connect; no phone step needed after the band has been
activated once), streaming is solid but time-limited. Across three clean runs with the band worn
and continuously active:

| run | stream duration | gestures | gyro samples |
| --- | --- | --- | --- |
| 1 | ~28 s | 5 | ~560 |
| 2 | ~38 s | 19 | 4521 |
| 3 | ~33 s | 59 | 4089 |

Data flows the whole time at ~256 DataX frames/s (~70 SDU/s) with the reader keeping up (largest
single read < 1 KB, no backlog), then the band ends it. The disconnect reason is
`ECONNRESET (errno 104)` — the band actively resets the L2CAP link.

Not fixable from our side, tested:
- A 4 MB socket receive buffer: reads were never behind, so credit starvation was not the cause.
- A keepalive status query every 10 s during streaming: the band ignored the queries (no reply)
  and still reset on schedule. So it is not a receive-watchdog we can feed.

This is almost certainly the unauthenticated-session grace period: the band grants a short window
to a peer that has not completed owner authentication, then resets. The companion app presumably
re-authenticates to hold the session open; that step is the same one the upstream POC left
unsolved. The POC's own captures were similarly short (tens of seconds).

Practical state: gestures and the wrist dial work and map correctly; sessions last ~30-40 s and
then need a button press to renew. Continuous operation would require the owner-auth handshake.

## After a reset the band goes silent until a button press (measured 2026-09-17)

`scripts/reconnect-test.ts`: get one streaming session, and the instant the band resets, purge its
BlueZ object and watch a continuous scan for 120 s with no button press.

Result: session streamed 47 s, then `ECONNRESET`. For the following **120 s the band emitted no
advertisement at all** (`re-advertised=false`) — BlueZ was scanning the whole time and saw nothing.

Implication: the post-session dormancy is the band, not our connect method. Neither CoreBluetooth
nor BlueZ can page a device that is not advertising, so no client — the Mac app included — can
reconnect without a button press. Each button press yields one ~30-50 s session; then the band is
dark until pressed again. This is hardware behavior in standalone (no glasses/phone) operation.

## RESOLVED: the ~30 s cap is the owner gate; enrollment fixes it (2026-09-20)

The kinesis author confirmed on the same firmware (`297b870dc9be+`) that a properly enrolled band
streams for minutes and auto-reconnects. The `0xc001` gate and the ~30 s teardown are the same
thing: the band opens its input service only to a client that proves ownership with the key the
band was enrolled with. The companion app does that proof automatically; our fresh-key sessions
could not, so the band dropped us.

The fix, ported here as `kinesis enroll`:
- Sign in to the user's Meta account (webview SSO; the client only handles the returned blob).
- Run the BLE ownership ceremony (identity read, skip-challenge nonce, start/finish change-owner),
  with two `graph.facebook-hardware.com` calls (`pair_request`, `pair`) that claim the band.
- Persist a P-256 signing key. Every later `run` sends `EnableTrust` (a signature over the session
  transcript) on channel `0x8002` instead of the empty identity query, and verifies the band's own
  `EnableTrustEC` proof, before link setup completes.

Ported modules: `identity.ts` (key + keychain→file storage), `ceremony.ts` (BLE ceremony),
`meta-auth.ts` (account sign-in), `meta-pair.ts` (hardware-graph pairing). The trust handshake and
the staged/enrolled setup state machine are covered by offline tests against a synthetic band.
This supersedes the earlier "not clearable client-side" conclusion, which was measured before the
enrollment key was in play.
