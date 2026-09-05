# Node-RED: validation and normalisation

Node-RED is the flow-based processing stage between MQTT ingestion and the
telemetry queue. It is where **Variety** is handled: four structurally
different payload types arrive on one topic tree and each is validated by its
own branch before being converted into a single shared envelope.

## What the flow does

```
MQTT in  transport/raw/#
        |
   remember source topic
        |
   identify mode  (5 outputs)
        |
        +--> validate bus     --+
        +--> validate tram    --+
        +--> validate train   --+--> normalise --> MQTT out transport/normalized/<mode>
        +--> validate demand  --+                              (+ debug: accepted)
        |
        +--> reject with reason ----> MQTT out transport/rejected/<mode>
                                                 (+ debug: rejected)
```

An invalid event **never reaches the normalised topic**, and therefore never
reaches the telemetry queue. It is published to `transport/rejected/<mode>`
with a machine-readable reason, and logged as:

```
[REJECTED]
  mode=bus
  eventId=evt-...
  reason=occupancy must be >= 0
```

Accepted events log a one-line counterpart:

```
[ACCEPTED] mode=bus eventId=evt-... BUS-001 health=normal delay=120s
```

## Why each mode has its own branch

The modes are not four copies of one payload. Each validates fields that only
make sense for it:

| Mode | Health states | Required mode-specific fields |
|---|---|---|
| bus | `normal` / `degraded` / `breakdown` | `roadSegmentId`, `nextStopId` |
| tram | `normal` / `degraded` / `blocked` | `trackSegmentId`, `direction`, `nextStopId` |
| train | `normal` / `degraded` / `cancelled` | `stationId`, `platform`, `carriageCount`, `nextStationId` |
| demand | n/a | `locationType`, `routeIds`, `passengerCount`, `demandLevel` |

A tram cannot "break down" - it is on rails, so its failure state is `blocked`,
and a blockage is a property of a track segment *and a direction*. A train stops
at numbered platforms and its capacity derives from its carriage count. A demand
event has no vehicle, no speed and no capacity at all. Sending a bus payload
down the tram branch fails, and vice versa; this is asserted in the tests.

## How the flow is maintained

The function-node code is **not** hand-edited inside `flows.json`. Each node's
body lives in its own readable file under `node-red/functions/`, and
`flows.json` is generated from them:

```bash
npm run flows:build     # regenerate node-red/flows.json
npm run flows:check     # fail if flows.json is out of date
```

`node-red/test/flow.test.js` loads `flows.json`, executes the **actual `func`
strings** through the real `wires` connections, and asserts the accept/reject
behaviour. The flow logic is therefore covered by `npm test` without needing a
Node-RED runtime.

If you edit a node in the Node-RED editor, copy the change back into the
matching file in `functions/` and re-run `npm run flows:build`, otherwise
`npm run flows:check` (and the test suite) will fail.

## Running it

### Locally

```bash
npm run broker      # terminal 1: local MQTT broker on :1883
npm run node-red    # terminal 2: editor on http://127.0.0.1:1880
```

Then in a third terminal:

```bash
npm run simulate -- --buses 5 --trams 3 --trains 2 --locations 4 --target mqtt --invalid-rate 0.2
node scripts/mqtt-tap.js "transport/normalized/#"
node scripts/mqtt-tap.js "transport/rejected/#" --payload
```

### With Docker

```bash
docker compose up broker node-red
```

The flow file is mounted read-only from the repository, so the committed flow is
the one that runs.

## Importing the flow manually

In the Node-RED editor: **menu -> Import -> clipboard**, paste the contents of
`flows.json`, then **Deploy**. Configure the MQTT broker node afterwards (see
below).

### Safe sequence after an external `flows.json` edit

The editor keeps an in-memory flow. If `flows.json` is changed by a repository
tool while an editor tab is still open, clicking **Deploy** from that stale tab
can overwrite the repository change. Use this sequence every time a generated
or externally edited flow is introduced:

1. Stop Node-RED.
2. Make or receive the `flows.json` change, then run `npm run flows:check`.
3. Start Node-RED again.
4. Hard-reload the browser editor (or open a new editor tab) and confirm the
   changed flow is visible.
5. Only then make editor changes and click **Deploy**.

## Pointing the flow at AWS IoT Core

The broker host and port are supplied as environment variables, so the same flow
works locally and against AWS:

| Variable | Local | AWS IoT Core |
|---|---|---|
| `MQTT_HOST` | `localhost` | the ATS endpoint returned by `aws iot describe-endpoint` |
| `MQTT_PORT` | `1883` | `8883` |
| `MQTT_CLIENT_ID` | `sit314-node-red` | any unique id allowed by the IoT policy |

TLS is **not** an environment variable, because Node-RED substitutes
environment variables as strings and any non-empty string is truthy. To switch
to AWS IoT Core:

1. Open the `transport-broker` config node in the editor.
2. Tick **Enable secure (SSL/TLS) connection**.
3. Add a TLS configuration node pointing at the three files in `certs/`:
   CA certificate `AmazonRootCA1.pem`, client certificate
   `device-certificate.pem.crt`, private key `device-private.pem.key`.
4. Leave **Verify server certificate** enabled.
5. Deploy.

Certificates are never committed and never copied into an image - see
`certs/README.md`.

## Security notes

- `settings.cjs` binds the editor to `127.0.0.1` only. The editor has no
  authentication configured, so it must not be exposed on a network interface.
  If it ever needs to be, add `adminAuth` first - see `docs/SECURITY.md`.
- `functionExternalModules` is disabled, so a function node cannot pull in
  arbitrary npm packages at runtime.
- The flow logs identifiers and reasons, never credentials.
