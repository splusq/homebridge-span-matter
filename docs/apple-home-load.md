# Apple Home load from the bridge

Findings from 2026-10-30.

| Fix | Status |
|---|---|
| 1. Publish fewer devices | `circuits.include` added. Skipping idle circuits is not done. |
| 2. Push fewer updates | Done: 5 W / 2% deadband, voltage and current wait for a power change or the 60 s heartbeat. The 1 s interval stays, because the solar and utility energy totals are integrated at it. |
| 3. Never remove devices on a partial view | Done |
| 4. Keep the feed-through once published | Done |
| 5. Don't re-push everything on a resync | Done |
| 6. Send changes in batches | Done: one batch every 30 s (`publishIntervalSeconds`); see [Report rate](#report-rate) |

## What happened

The Home app on a Mac stopped showing changes made on an iPhone. Restarting
`homed`, the Mac's HomeKit daemon, fixed it. iCloud sync and the link to the
home hub were working the whole time, so the stall was inside `homed`. Its own
logs can't say why: macOS stopped recording them for high volume
("quarantined due to high logging volume") minutes after that process started
on 2026-10-27.

Restarting `homed` with the Home app open showed where the volume comes from.
The bridge published 30 devices (Matter endpoints 2–31, plus the root and
aggregator endpoints 0 and 1):

| Measured on the Mac | |
|---|---|
| Attribute reads of the bridge in the first 20 s | 12,267 |
| Full walks of the bridge's structure | 29: every endpoint's ServerList, and every cluster's AttributeList and AcceptedCommandList, read 29 times each |
| Descriptor cluster reads | 4,669 |
| `homed` CPU | 15% at 90 s, 7.7% at 110 s |

29 walks for 30 devices means `homed` walks the whole bridge about once per
device, so its work grows with the square of the device count. That pattern is
Apple's, but the device count is ours. With 10 devices, those reads should drop
to roughly a ninth (an estimate, not measured).

This doesn't prove the bridge caused the stall. It is the biggest load on
`homed` we could see, and every fix below also lightens the load on the Apple
TV or HomePod that subscribes to the bridge.

## Report rate

A later look at `homed` in steady state showed where most of its time goes.
The home hub relays each Matter report from the bridge to the Mac. For every
one, `homed` creates a device object for the bridge, loads all 160 of its
clusters from disk, injects the report, then tears the object down and
suspends its controller again. In 5 minutes on 0.1.4:

| | |
|---|---|
| Reports relayed to the Mac | 300, one per second: one per flush |
| Reports that reached a device object already torn down | 299 |
| Whole-bridge loads from disk | 525 |
| `homed` log lines | 51,382 |

So the Mac dropped almost every live update while paying a full reload for
each. The cost scales with the number of reports times the size of the
bridge. The number of attributes in a report barely matters.

0.1.5 thinned the attributes but still flushed every second, and with 26
circuits something crosses the deadband almost every second: 266 reports in
5 minutes, 36,096 log lines, `homed` at 22% CPU. Batching changes into one
report every 30 s cuts reports about 30-fold. Against the mock panel, 0.1.5
sent 1.01 batches a second and the batched build 0.032.

## Fixes, in priority order

### 1. Publish fewer devices

Every circuit becomes a device ([mapping.ts:174](../src/mapping.ts#L174)). The
only way to drop one is `circuits.exclude`, which needs each name typed in.

- Add `circuits.include`, an allowlist, so a user can publish just the circuits
  they care about.
- Offer to skip circuits with no load history (spare breakers), for example
  lifetime imported energy below a threshold. Make it opt-in or new-install
  only: removing a device from an existing home deletes it in Home, along with
  its room and automations.
- Say in the README that every published device adds load on every Apple
  device in the home, and that 30 is a lot.

### 2. Push fewer updates

The defaults are a 1 s interval and a 1 W deadband
([platform.ts:119](../src/platform.ts#L119),
[platform.ts:413](../src/platform.ts#L413),
[config.schema.json:90](../config.schema.json#L90)). On top of that, a circuit
pushes whenever voltage moves 0.5 V or current moves 50 mA
([platform.ts:435](../src/platform.ts#L435)).

Voltage is one panel-wide value copied onto every circuit
([mapping.ts:265](../src/mapping.ts#L265)). A 0.5 V wobble on the mains makes
every circuit push together, on every flush. The upper bound today is 30
devices × 3 attributes every second, about 90 attribute changes a second sent to
each subscribed controller. That rate hasn't been measured on the bridge.

- Drop voltage and current from circuit devices
  ([platform.ts:245](../src/platform.ts#L245)) and keep them on the grid or
  panel device. First check on an iPhone that Home doesn't show them for
  circuits. It doesn't appear to, but that isn't confirmed.
- If they stay, don't let them trigger a push on their own; send them only
  along with a power change.
- Raise the defaults to about a 5 s interval and a relative deadband, the
  larger of 5 W and 2% of the reading. Add a heartbeat that pushes any change at
  least once a minute, the way energy totals already work.

### 3. Never remove devices based on a partial view of the panel

This is also a data-loss bug in its own right. `sync()` unregisters any cached
device that `discover()` didn't return
([platform.ts:338](../src/platform.ts#L338)). `discover()` returns nothing when
the panel's root device hasn't arrived ([mapping.ts:102](../src/mapping.ts#L102)),
and `start()` syncs anyway once `waitForTree` gives up after 60 s
([platform.ts:199](../src/platform.ts#L199)). If the panel is slow after a power
cut or a reboot:

1. Every device is unregistered, and Home deletes them with their rooms and
   automations.
2. `published` is empty, so the `device` handler never schedules another sync
   ([platform.ts:142](../src/platform.ts#L142)). The devices stay gone until
   Homebridge restarts.
3. When they come back, Home treats them as new devices, and every Apple device
   walks the whole bridge again.

A partial tree does the same to whichever circuits haven't arrived yet.

Skip removals unless the tree is complete and has a root, and retry the sync
instead. Better still, remove a device only after it has been missing from
complete syncs for a while (say 24 h), or when the user excludes it.

### 4. Keep the feed-through device once it's published

In `auto` mode, the feed-through device exists only while net downstream energy
is above 1 kWh and 5% of upstream import
([mapping.ts:156](../src/mapping.ts#L156)). The comment above that line notes
these counters drift both ways. Every sync re-decides, so near the threshold
the device can appear and disappear, changing the bridge's structure each time.
Once it's published, keep it until the user sets `never`.

### 5. Don't re-push everything on a resync

`sync()` clears every device's last-pushed state and re-sends every attribute
([platform.ts:384](../src/platform.ts#L384)). That's needed at startup, because
restored devices hold stale cached values. On a resync for a new device or a
rename, only newly registered devices need it.

## Outside the bridge's control

- **The test vendor ID.** Homebridge publishes the bridge as vendor `0xFFF1`,
  product `0x8001`. Apple's database doesn't know that vendor, so `homed` logs
  "could not be found in the VIDB", and the Home app retries its vendor lookup
  about twice a second while it's open. A real vendor ID requires CSA
  membership and certification.
- **Apple walking the whole bridge once per device.** Worth reporting through
  Feedback Assistant, with the numbers above and a sysdiagnose.

## Checking a fix

On a Mac in the home, open the Home app, then restart `homed`:

```bash
killall homed
```

After a minute, count its reads of the bridge. The full path to `log` avoids
any shell function or alias with the same name:

```bash
/usr/bin/log show --last 2m --info --debug --style compact --predicate "processID == $(pgrep -x homed)" | grep -c readAttributeWithEndpointID
```

The baseline is 12,267 with 30 devices.
