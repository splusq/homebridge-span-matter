# homebridge-span-matter

Puts a [SPAN](https://www.span.io) smart panel into Apple Home's **Energy** view over Matter: the grid meter, every circuit, solar and battery, streamed live from the panel's local eBus API. It doesn't use the SPAN cloud or polling.

## What you get in Apple Home (iOS 27)

| SPAN | Matter device | In Home |
|---|---|---|
| Upstream lugs (utility service) | Electrical Sensor + **Electrical Meter** | The whole-home figure for "All Home": signed power, lifetime import and export |
| Each circuit | Electrical Sensor (or Outlet, see below) | Per-circuit watts, volts and amps, plus lifetime energy |
| Circuit feeding PV | Electrical Sensor, negative power | Solar production and lifetime export |
| Circuit feeding a battery (or the BESS) | Electrical Sensor + Power Source | Charge/discharge power and state of charge; see below |
| Downstream lugs (sub-panel) | Electrical Sensor | Only when it shows a real net import (configurable) |

### Battery gateways upstream of the panel

A Tesla Powerwall gateway (or another DER) between the utility and the panel changes what the upstream lugs measure: the panel's own load, not the grid. The plugin reads this from the lugs' `fed-by` connection and then:

- publishes **Utility Grid** (from the panel's `power-flows/grid`) as the whole-home meter, and the lugs as **SPAN Panel**, with their measured counters. Set `wholeHomeMeter: "panel"` to swap which one Apple Home uses for "All Home".
- publishes the battery (named after its model, e.g. "Powerwall 2 AC") and **Solar** from the BESS meter and `power-flows`.

These sources report power only, so their energy is **integrated from 1 Hz power samples**. The totals are saved in `<storage>/span-matter/<serial>-energy.json`. They start at zero on first run and don't bridge gaps longer than 10 s.

**Where things appear in Home:** Electrical Sensors have no room tile. They are listed under the **Electricity** category at the top of the Home tab, in **All Home**. Set `circuits.mode` to `outlet` to give every circuit a tile with live watts instead.

iOS 27 shows an Electrical Sensor that carries a battery as a tile with its percentage, labelled "Not Supported". Choose what you prefer: keep that (the default), set `batteryLevel: false` to drop the tile and label, or set `batteryMode: "outlet"` for a supported tile whose switch does nothing.

Battery and solar use these types rather than Matter's Battery Storage and Solar Power device types. iOS 27 shows a bridged Battery Storage device as "Not Supported", so these were left out until Apple supports them.

## Why the mapping is small

SPAN's eBus `meter` capability and Matter's Electrical Power/Energy Measurement clusters describe the same quantities. The plugin scales units (W→mW, Wh→mWh, V→mV, A→mA) and fixes one sign:

- **Grid:** eBus measures at the panel and Matter at the device, but for the service entrance these are the same frame. Values pass straight through.
- **Circuits:** eBus measures from the busbar, so a load is negative and accumulates "exported" energy. Matter measures from the device. The plugin negates power and swaps the import/export counters.

The result balances: grid power equals the sum of every circuit's Matter power. The test suite checks this.

## Requirements

- Homebridge **2.4.0 or later**, with **Matter enabled on the bridge** that runs this plugin. A child bridge is recommended.
- SPAN firmware with the v2 API (r202603 or later). The v1 REST API that older plugins use is removed on 2026-12-31.

## Setup

1. Install the plugin, add the platform, and set `host` to the panel's address. The `.local` name it advertises, such as `span-nj-1234-abcde.local`, survives IP changes and matches the panel's TLS certificate.
2. Turn on Matter for the bridge and restart.
3. On first start the log asks you to **open the panel door and press the door switch 3 times**. The plugin registers itself, then upgrades to a full-privilege client using the passphrase the panel returns. Credentials are kept in `<homebridge storage>/span-matter/`. You can instead set `hopPassphrase`, or register ahead of time from a shell:

   ```bash
   npx span-matter register span-nj-1234-abcde.local --storage ~/.homebridge
   ```

4. Pair the bridge's Matter code in the Home app.

`span-matter probe <host>` prints every device the plugin would publish, with live values in Matter units.

## Options

| Key | Default | |
|---|---|---|
| `host` | (required) | Panel address |
| `hopPassphrase` | none | Register without the door switch |
| `circuits.mode` | `sensor` | `outlet` gives each circuit a room tile with live power. Switching mode re-creates the devices; remove and re-add the bridge in Home afterwards. |
| `circuits.allowRelayControl` | `false` | Outlet mode only. When on, a tap opens or closes the breaker relay. When off, taps are undone. |
| `circuits.include` | `[]` | When set, the only circuits published, by name or id. Solar and battery are always published. |
| `circuits.exclude` | `[]` | Circuit names or ids to skip |
| `feedthrough` | `auto` | `auto`, `always` or `never` |
| `wholeHomeMeter` | `utility` | With a gateway upstream: `utility` or `panel` |
| `batteryMode` | `sensor` | `sensor`, or `outlet` (supported tile; its switch does nothing) |
| `batteryLevel` | `true` | Publish state of charge on the battery |
| `updateIntervalSeconds` | `1` | How often readings are checked and energy is integrated |
| `publishIntervalSeconds` | `30` | How often changes go to Apple Home, in one batch. Relay switches go out at once. |
| `powerDeadbandWatts` | `5` | Smaller power changes wait up to 5 minutes. Voltage and energy totals also go out every 5 minutes, voltage sooner on a 2 V swing. |
| `powerDeadbandPercent` | `2` | Same, as a share of the reading; the larger of the two applies |

New circuits and renames on the panel are picked up automatically. A device is removed only once the panel has described every device and that one is gone, so a panel that is slow to come back after a power cut does not delete devices from Home.

### Load on Apple Home

The home hub relays every report the bridge sends to the other Apple devices, and a Mac's `homed` reloads the whole bridge from disk for each one. What costs is how often the bridge reports and how big it is, not how much each report carries. So changes go out in one batch every `publishIntervalSeconds`. Sending every second kept a Mac's `homed` near a third of a CPU core with 30 devices.

Every published device also adds to the cost of each report and of each Home restart: a Mac's `homed` walks the whole bridge once per device, so that work grows with the square of the device count. On a busy panel, use `circuits.include` to publish just the circuits you watch. [docs/apple-home-load.md](docs/apple-home-load.md) has the measurements.

### Memory

A Matter child bridge costs about 250 MB before this plugin publishes anything; Homebridge and matter.js are most of it. The once-a-second updates keep the process busy, so V8 never shrinks its young generation and the heap sits about 65 MB above what is live. Capping the young generation removes that with no loss: in the child bridge's settings, or under `_bridge` in `config.json`, set

```json
"env": { "NODE_OPTIONS": "--max-semi-space-size=1" }
```

and restart the bridge.

## Development

```bash
npm test                         # build + unit tests
node scripts/mock-panel.mjs      # fake panel: REST on :8080, MQTTS eBus on :18883
node dist/cli.js probe localhost:8080 --storage /tmp/span-dev
```

The mock serves a full device tree, including PV and a Powerwall on breakers, with values that change every second. Point a Homebridge with Matter at `host: "localhost:8080"` to test the plugin end to end.
