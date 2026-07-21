# Installing on Homey

## One-time setup

The Homey CLI **4.x is broken on Node 22** (`ERR_REQUIRE_ESM` on every command,
a bug in the CLI itself). Use v3:

```powershell
npm install -g homey@3
```

Then log in — this opens a browser:

```powershell
homey login
```

## Install

Run every command **from the `app` folder** — the CLI looks for `app.json` in
the current directory and fails with ENOENT anywhere else.

```powershell
cd G:\XiaomiCleanerHomeyApp\app
homey app install
```

The app stays on the Homey after the terminal closes.

### `homey app run` needs Docker

`homey app run` emulates the app locally and **requires Docker Desktop**
(`Could not connect to Docker` without it). `homey app install` uploads
straight to the Homey and does not. Docker is only worth installing if you
want live logs while developing.

Without it, read logs from: Homey app -> Apps -> Xiaomi X20+ Vacuum -> Logs.

## Pairing the robot

Homey app -> Devices -> + -> Xiaomi X20+ Vacuum -> Xiaomi Robot Vacuum X20+

It asks for IP and token. Values for this robot are in `.env`:

- IP: `192.168.1.36`
- Token: 32 hex characters

Pairing does a real handshake and refuses to create the device if the robot
does not answer, so a bad IP/token fails immediately rather than silently.

## Exporting the log

Homey app -> Apps -> Xiaomi X20+ Vacuum -> Settings (gear) -> Load log -> Copy.

Do this after a clean where the robot recharged mid-job — that log is what is
needed to add a reliable "cleaning finished" notification.

## Notes

- Placeholder images and icon are generated; replace them with real artwork
  before publishing anywhere.
- `homey app validate` passes at `publish` level.
