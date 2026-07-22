# Installing on Homey

## One-time setup

The CLI version must match the Node version — mismatching them breaks every
command, including `--version`:

| Node | CLI | why |
|------|-----|-----|
| >= 24 | `homey` (4.x) | `homey-api` requires Node >= 24 |
| 22 | `homey@3` | v4 throws `ERR_REQUIRE_ESM` on every command |

On Node 22, the "Update available 3.x → 4.x" banner is a trap: npm only warns
about the engine mismatch and installs anyway. Roll back with
`npm install -g homey@3`. Apps already installed on the Homey are unaffected —
only the local CLI breaks.

### Upgrading Node on Windows

`winget upgrade OpenJS.NodeJS` may fail with **error 1714 / system 1612** ("the
older version cannot be removed") when the original MSI is no longer cached.
Rather than repairing the MSI, install [nvm-windows](https://github.com/coreybutler/nvm-windows)
and leave the broken install alone:

```powershell
winget install CoreyButler.NVMforWindows
# new terminal
nvm install 26
nvm use 26
```

Two gotchas after switching:

- **npm 11 blocks install scripts.** A plain `npm i -g homey` leaves native deps
  unbuilt and the old binary in place. Use
  `npm install -g --allow-scripts=sharp,protobufjs,ssh2 homey`.
- **Stale shims win on PATH.** `%APPDATA%\npm` comes before nvm's directory, so
  its leftover `homey`, `homey.cmd`, `homey.ps1` keep launching the old version
  even once v4 is installed. Delete those three files; `Get-Command homey`
  should then resolve under `C:\nvm4w\nodejs`.

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

It asks for the robot's IP address and its 32-character miIO token. See the
README for how to extract the token.

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
