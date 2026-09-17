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
hypothesis is now that this band still has the Meta AI app registered as its owner, and newer
firmware gates the input service on owner authorization until the band is unpaired from that app.

## BlueZ connection notes for this firmware

- The band's connectable window after a button press is short. Reliable path: scan until it
  advertises (RSSI present), `StopDiscovery`, wait for `Discovering=false`, then `Connect`.
  Connecting while discovery is active gives `le-connection-abort-by-local`.
- Bonding hurt reconnection here: once bonded, `Connect` to the identity address timed out while
  the band advertised a fresh resolvable-private address. Removing the bond and connecting fresh
  worked. The app should probably not pair unless the PSM read demands it.
