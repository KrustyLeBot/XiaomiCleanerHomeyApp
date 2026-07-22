# Working on this repo

Homey app for the Xiaomi X20+ (`xiaomi.vacuum.c102gl`), local miIO only.
Read [FINDINGS.md](FINDINGS.md) before touching anything protocol-related.

## Conventions

- **Code and comments in English.** UI strings are bilingual EN/FR via
  `app/locales/*.json` and the `title` objects in `app.json`.
- **Internal identifiers are English** (`paused_cleaning`, not `pause_nettoyage`).
  Only display names get translated.
- Comments explain *why*, not *what*. Keep them at the density of the
  surrounding file.

## Hard rules learned the hard way

### No local state that mirrors the robot

Anything the robot reports must be **read from the robot every poll**, never
remembered locally and reused. Local mirrors go stale across app restarts and
whenever the robot is driven from the Xiaomi app or its own button.

Flow conditions must read `getCapabilityValue('vacuum_status')`, not instance
variables. A condition once compared the raw status (`3`) to a state id
(`paused_cleaning`) and silently never matched.

The only surviving instance state, and why it is acceptable:

| var | purpose | safe because |
|-----|---------|--------------|
| `lastStatus` / `lastState` | detect *changes* between polls | compared against fresh values, never a source of truth |
| `runningArea` | peak area of the run in progress | frozen into `last_cleaned_area` on dock arrival |
| `cleanedThisCycle` | "did it really clean?" guard for `task_completed` | only gates one notification; without it the robot's nightly dock wandering would spam |
| `failures` | consecutive read timeouts | unrelated to robot state |

### Verify field meanings against the Xiaomi app

Do not infer what a MIoT field means from a plausible-looking pattern. `4/3`
was once read as the "paused from" field because it happened to hold 6 and 11
during two pauses — it is the **cleaned area**. The Xiaomi app shows area and
time live; compare against it before believing a mapping.

A field that climbs during one uninterrupted activity is a counter, not a code.

### Field map (do not mix these up)

| field | meaning |
|-------|---------|
| **`4/7`** | **activity code** — `1` cleaning · `0` returning · `6` paused mid-clean · `11` paused mid-return · `16` blocked mid-return |
| **`4/3`** | **cleaned area in m²** — matches the Xiaomi app exactly |
| `4/2` | cleaning time in minutes |
| `4/1` | secondary status enum, unused |
| `2/1` | status (see FINDINGS) |
| `2/2` | fault, non-zero only in status 4 |

### The poll uses WATCHED, not PROPERTIES

`device.js` polls `WATCHED` (from `lib/recorder.js`), whose keys are raw dids
(`s4p3`, `s4p7`). Reading `values.clean_area` there yields `undefined` and the
capability is silently never written — this caused a tile stuck on "-" for a
while. Keep the two lists in sync or read the raw did.

### Timeline booleans are toggled, never set true/false in pairs

Homey's per-device timeline only records **boolean capability changes**, and a
`true -> false` transition logs an entry too. So each state has one hidden
boolean that is **toggled** on entry (value is meaningless) and the others are
left untouched. Setting them all true/false produced phantom "started" events.

Toggle **only when the displayed state changes**, never every poll.

### Stuck notifications run every poll, not on state change

`updateStuckNotification()` is called on **every** poll, before the
`status changed` gate. It was once inside `fireTriggers`, which only runs on a
change — so a pause whose transition poll was lost to a network timeout never
armed its timer and never notified.

One trigger card per stuck state (`paused_cleaning`, `paused_returning`,
`error_returning`, `error`), each named exactly like the state so the card is
looked up by state id. All share the 90 s confirm delay and the
one-notification-per-episode guard.

### Don't add conditional buttons

Homey has no runtime show/hide for capabilities. `addCapability` /
`removeCapability` work but are documented as expensive and break flows that
depend on them. Control stays in flow cards.

## Two resume actions, deliberately

`4/7` now tells us reliably which activity was paused, but the app still ships
**two explicit resume cards**. Resuming a paused dock-return with "resume
cleaning" starts a **full clean of the whole home** — the destructive case. The
user's flow picks; the app never guesses.

## Capability migration

New capabilities are added to already-paired devices by `migrateCapabilities()`
in `onInit`. Without it a new tile shows "-" until the user removes and re-adds
the device.

## Checks

```bash
cd app
homey app validate --level debug   # CLI v4 is broken on Node 22, use homey@3
```

Live-read the robot with the scripts in `probe/` (credentials come from `.env`,
which is gitignored and must never be committed or echoed into docs).
