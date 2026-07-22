# Xiaomi X20+ Vacuum — Homey App

A small Homey app for the **Xiaomi Robot Vacuum X20+** (`xiaomi.vacuum.c102gl`),
talking to it **locally** over the miIO protocol (UDP, AES-128) — no cloud.

It exists because the general-purpose `com.xiaomi-miio` app collapses the robot's
real states into Homey's five standard vacuum values, which throws away the one
distinction that matters: **was the robot interrupted while cleaning, or while
driving back to the dock?** Those need different handling, and the standard app
can't tell them apart. This app can.

The app is bilingual (English / French): it follows Homey's language. Internal
identifiers are English; only the display names are translated.

## What it does

- **Precise status** — a dedicated `Status` capability with the robot's real
  states, including the two that the standard app merges (cleaning-paused vs
  return-paused). See the state table below.
- **Two separate resume actions** — *Resume cleaning* and *Resume return to
  dock*. They are deliberately separate: from a paused dock-return, sending
  "resume cleaning" starts a **brand-new full clean** of the whole home. The app
  never guesses which one you meant.
- **Actions** — Start, Pause, Resume (×2).
- **Flow triggers** — cleaning interrupted, dock-return interrupted, blocked
  returning to dock, blocked (error), cleaning finished, status changed. The
  four "robot is stuck" triggers all fire 90 s after the robot stops, and are
  cancelled if it frees itself first.
- **Insights graph** — cleaned area per run (`Cleaned area`).
- **Device timeline** — every state change appears in Homey's native per-device
  timeline (via one hidden boolean per state, the only mechanism Homey offers).
- **Raw MIoT log** — exportable CSV from the app settings, for diagnosing edge
  cases, plus an error panel showing failed capability writes.

All values below were reverse-engineered by probing a real robot, not taken from
a spec sheet — the published spec for this model is for a different variant
(`d109gl`, the X20 Max) and is **wrong** for the `c102gl`. See
[FINDINGS.md](FINDINGS.md) for the full detective work.

## Discovered MIoT map

Firmware `4.5.6_1087`. Reads use `get_properties` (array params); actions use
`action` (a **bare object** — wrapping it in an array makes the robot reply
`-9999`).

### Properties

| what | siid | piid | notes |
|------|------|------|-------|
| status | 2 | 1 | the main state enum (below) |
| activity / paused-from | 4 | 7 | `1` cleaning · `0` returning · `6` paused mid-clean · `11` paused mid-return · `16` blocked mid-return |
| cleaned area (m²) | 4 | 3 | climbs during a run; matches the Xiaomi app exactly |
| cleaning time (min) | 4 | 2 | minutes elapsed this run |
| battery % | 3 | 1 | |
| charging state | 3 | 2 | `1` on dock, `2` off dock, `5` driving home |

The published `d109gl` spec puts status at `2/2` and fault at `2/3`. On the
`c102gl` those are wrong — status is `2/1`, and most of the `d109gl` properties
don't exist on this firmware.

The area and activity fields were pinned down by comparing against the Xiaomi
app live (it read 14 m² / 17 min while `4/3` read 14 and `4/2` read 18), and by
pausing a clean and a dock-return in turn: `4/7` was the only field that
differed between the two pauses.

### Status enum (siid 2 piid 1)

| value | meaning | app state |
|-------|---------|-----------|
| 1 | cleaning | `cleaning` |
| 3 | paused — cleaning **or** returning (disambiguated by paused-from) | `paused_cleaning` / `paused_returning` |
| 5 | driving back to dock | `returning` |
| 6 | on dock, charging | `charging` |
| 13 | on dock, fully charged | `docked` |
| 22 | station cycle (dust/mop), briefly after docking | `station` |
| 4 | blocked / error, waiting for the user (`fault` non-zero) | `error_returning` / `error` |
| other | unseen value | `unknown` |

Status `15` (Error) from the published spec **never appears** on this robot - the real error status is `4`, seen when an obstacle blocked the dock return.

### Actions

| action | siid | aiid | app action |
|--------|------|------|-----------|
| start / resume cleaning | 2 | 1 | Start / Resume cleaning |
| pause | 2 | 2 | Pause |
| go home / resume return | 3 | 1 | Resume return to dock |

Note there is **no** separate "continue" action: from a paused clean, aiid `2/1`
resumes it; from the dock, the same aiid starts a fresh clean.

## Requirements

- Homey Pro (SDK 3, local platform)
- The robot on a **fixed local IP** (set a DHCP reservation in your router)
- The robot's **32-character miIO token** (see below)

## Getting the IP and token

The robot only accepts local commands from someone holding its token. Extract it
with **[Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor)**
by PiotrMachowski:

1. Run the tool (Windows exe, Docker, or `python token_extractor.py`).
2. Log in with your **Xiaomi Mi Home** account and pick your region server
   (e.g. `de`, `cn`, `us`).
3. It lists every device with its **name, IP, and token**. Copy the IP and the
   32-hex token for the X20+.

The token is a secret — treat it like a password.

## Install

See [INSTALL.md](INSTALL.md). Short version:

```bash
npm install -g homey@3     # CLI v4 is broken on Node 22; use v3
homey login
cd app
homey app install
```

Then pair: **Devices → + → Xiaomi X20+ Vacuum**, and enter the IP and token.
Pairing does a real handshake and refuses to pair if the robot doesn't answer.

## The killer flow

The reason the app exists — relaunch a clean the cat interrupted, without
relaunching a dock-return:

- **When** `Status` becomes *Cleaning paused*
- **Then** notify + *Resume cleaning*

Add a retry guard (stop after N attempts) so a robot stuck under furniture
doesn't loop forever.

## Known limitations

- **Mid-clean recharge** isn't handled yet. If the robot tops up mid-job, the
  "cleaning finished" trigger and the area graph both treat the intermediate
  dock as an end. The firmware exposes no "job pending" flag, and this case has
  not been captured live yet — it will be fixed once a real recharge is logged.
- **Poll granularity.** States shorter than the poll interval (default 10 s,
  configurable) may not be recorded.
- **Stuck notifications are delayed 90 s.** The robot stops briefly on its own
  and resumes unaided, so notifying immediately produced false alarms. Applies
  to both pause and error triggers.

## Project layout

```
app/            the Homey app
  lib/          miIO client, state mapping, history, recorder
  drivers/      the x20plus device + driver + pairing view
  settings/     history + raw-log page
probe/          standalone Node scripts used to reverse-engineer the robot
FINDINGS.md     everything learned by probing the real device
INSTALL.md      install steps and CLI gotchas
```

## Credits

- Protocol and state mapping cross-checked against
  [shaarkys/com.xiaomi-miio](https://github.com/shaarkys/com.xiaomi-miio).
- Token extraction:
  [PiotrMachowski/Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor).
- miIO protocol reference:
  [rytilahti/python-miio](https://github.com/rytilahti/python-miio).
