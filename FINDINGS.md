# X20+ (xiaomi.vacuum.c102gl) — probed facts

Firmware `4.5.6_1087`, probed live over local miIO.
These values come from the robot, not from a spec sheet.

## Verdict on the two conflicting specs

`homey-x20plus-recap.md` was written from the **d109gl (X20 Max)** spec and is
**wrong for this robot**. The shaarkys app's `properties_c102gl` mapping is correct.

| what | recap.md (d109gl) | actual c102gl | correct |
|------|-------------------|---------------|---------|
| status | siid 2 piid 2 | **siid 2 piid 1** | app |
| fault | siid 2 piid 3 | **siid 2 piid 2** | app |
| battery | siid 3 piid 1 | siid 3 piid 1 | both |

The recap's 21-value status table (1=Idle, 2=Charging, ... 20=WashBreak) belongs
to a different enum and must not be used.

## Real property surface

Everything else in siid 2 / siid 3 returns `code -1` (does not exist).

| siid | piid | observed | meaning |
|------|------|----------|---------|
| 2 | 1 | 6 | **status** (enum below) |
| 2 | 2 | 0 | fault (0 = no fault) |
| 2 | 3 | 3 | sweep-mop-type |
| 2 | 5 | 0 | — |
| 2 | 6 | 2 | — |
| 2 | 8 | 2 | — |
| 3 | 1 | 95 | battery % |
| 3 | 2 | 1 | charging state (1 = charging) |

Notably absent on this firmware: siid 2 piid 4 (mode) and piid 7 (clean-time).

## siid 4 — activity, area and time

Confirmed live against the Xiaomi app and by pausing each activity in turn.

| piid | meaning | values |
|------|---------|--------|
| 7 | **activity code** | `1` cleaning · `0` returning · `6` paused mid-clean · `11` paused mid-return · `16` blocked mid-return |
| 3 | **cleaned area, m²** | matches the Xiaomi app exactly (app said 14 m², field read 14) |
| 2 | **cleaning time, minutes** | app said 17 min, field read 18 |
| 1 | secondary status enum | `2` cleaning · `3` returning · `6` docked |

`4/7` is what separates the two kinds of pause: with the robot paused, it was
the ONLY field that differed between a paused clean (6) and a paused
dock-return (11). Everything else - status, charging, 4/1, 4/3, 4/4, 4/5 - read
identically in both.

### Trap: 4/3 is NOT the pause field

An earlier pass read 6 and 11 in `4/3` during two pauses and concluded it was
the "paused from" field. It is not - `4/3` is the cleaned area, and it merely
happened to be 6 m² and 11 m² at those moments. The giveaway: during a single
uninterrupted clean `4/3` climbs 0 -> 11 -> 18 -> 21, which no activity code
would do. Verify any such field against the Xiaomi app before trusting it.

## Error state (status 4)

Captured live: the robot hit an obstacle on its way back to the dock and waited
for the user.

```
17:23:38  status=5  fault=0   4/7=3    returning normally
17:23:48  status=4  fault=63  4/7=16   BLOCKED - waiting for the user
17:24:58  status=5  fault=0   4/7=3    resumed after "resume return to dock"
```

- `status 4` = blocked / error, the only status where `fault` is non-zero
- `fault 63` = the error code for this obstacle case
- `4/7 = 16` = blocked **while returning**, which makes it actionable: the fix is
  "resume return to dock", not "resume cleaning"

Treated as **active** by the app, so the running area is preserved while the
robot waits rather than being reset to 0.

## Status enum (siid 2 piid 1)

Confirmed by driving the robot through each state over two sessions:

| value | state |
|-------|-------|
| 1 | cleaning |
| 3 | paused — cleaning **or** dock-return, indistinguishable |
| 5 | returning to dock |
| 6 | docked |
| 22 | station working (brief, right after docking) |

Not observed: any error value. The recap doc's `15 = Error` never appeared,
including when the wheels were lifted mid-clean.

## Charging state (siid 3 piid 2)

| value | meaning |
|-------|---------|
| 1 | on dock / charging |
| 2 | off dock, not charging |
| 5 | actively driving back to dock |

`5` appears exactly when status is `5` and clears the moment the robot docks.
It tracks *driving home*, not intent.

## The two kinds of pause: distinguishable via siid 4 piid 7

Status alone cannot tell them apart - pausing a clean and pausing a dock-return
both yield status `3` with charging `2`, byte-identical (verified by sending the
robot home, pausing it, and watching it hold for 30 s).

But `siid 4 piid 7` does distinguish them: `6` when the paused activity was
cleaning, `11` when it was the dock-return. Verified by pausing each in turn and
diffing every readable field - `4/7` was the only one that differed. The app
reads it directly, with no local tracking of the previous status.

Rejected hypothesis along the way: charging `5` looked like a "was docking"
marker, since one log showed `3`/`5` together. That sample was the robot briefly
resuming its drive, not intent being retained. `charging=5` only ever
accompanies `status=5` (actively driving home).

The app still ships **two explicit resume actions** rather than one "resume
whatever you were doing": the state is now known reliably, but a wrong resume is
destructive (see below), so the choice stays with the user's flow.

### Why this is dangerous, not just inconvenient

From `status=3` (paused), the resume you send must match what the robot was
actually doing:

- paused mid-dock-return + `siid 3 aiid 1` -> correctly continues home
- paused mid-dock-return + `siid 2 aiid 1` -> **starts a brand-new full clean
  of the whole flat**

Since a paused dock-return is indistinguishable from a paused clean, any
"smart" auto-resume will eventually pick wrong and launch a full clean by
mistake — most likely while nobody is home to stop it.

=> ship **two explicit** actions: resume cleaning, resume dock-return.
The user's flow decides which; the robot cannot. Do NOT add an auto-resume
that guesses.

## Action call format (important)

`get_properties` takes params as an **array**:

```js
call('get_properties', [{ did: 's', siid: 2, piid: 1 }])
```

`action` takes params as a **bare object** — wrapping it in an array makes the
robot reply `{"code":-9999,"message":"user ack timeout"}` and do nothing:

```js
call('action', { did: 'call-2-1', siid: 2, aiid: 1, in: [] })   // works
call('action', [{ did: 'call-2-1', siid: 2, aiid: 1, in: [] }]) // -9999
```

A `-9999 user ack timeout` therefore means *malformed request*, not *unknown
action*. Two aiids were wrongly written off this way before the format was found.

### Verified actions

All tested live on the robot, all replied `code 0`:

| action | call | observed |
|--------|------|----------|
| start / resume cleaning | siid 2 aiid 1 | status 3 -> 1 |
| pause | siid 2 aiid 2 | status 1 -> 3, and 5 -> 3 |
| go home / resume dock-return | siid 3 aiid 1 | status 3 -> 5, charging -> 5 |

`siid 2 aiid 8` ("Continue Sweep" per the recap doc) was never validly tested —
the two attempts used the wrong param format. Untested, and not needed: aiid 1
resumes a paused clean correctly.

## Mid-clean recharge — not detectable, and not a problem

The robot sometimes returns to charge mid-job and resumes on its own. No probed
property flags "job pending":

- `siid 4 piid 7` is the activity code (see the siid 4 section below) - it says
  what the robot is doing, not whether a job is outstanding.
- `siid 4 piid 1` is a second status field (2 = cleaning, 3 = returning,
  6 = docked). Same information, different enum.

Sending the robot home mid-job **aborts** the job — everything returns to the
idle baseline. That is NOT the same as a self-initiated recharge, so it cannot
be used to reproduce the case. A real recharge needs the battery to actually run
low mid-clean; untested so far.

This turns out not to matter. A recharge goes `1 -> 5 -> 6 -> 1` and never
passes through `3` (paused), so the pause notifications do not fire spuriously.
Verified against the trigger logic.

If you ever catch a real mid-clean recharge, run `probe.js watch` during it —
a distinct status value there would allow an explicit "recharging" state.

## Completion trigger (task_completed)

Fires when the robot is back on the dock (status 6 or 13) AND status 1
(cleaning) was seen this cycle. The "actually cleaned" guard is essential: the
robot leaves the dock and returns on its own repeatedly at night (10 times in
one logged night, 60-750s away each), never cleaning - "reached dock" alone
would spam. Verified against a 15h log: fires once per real clean, never during
night wandering.

siid 4 piid 1 is a cleaning-progress counter (0..N over the run, holds while
docked, resets next clean) - candidate for a future progress capability.

KNOWN LIMIT: a mid-clean recharge docks with the flag still set, so it fires
once early. Needs a real recharge log to separate "docked to recharge" (low
battery, leaves again) from "docked, done". Today's logs never dropped below
80%, so the case is still uncaptured.

## Still open

- Value for a **normally completed** clean (every test run was stopped
  manually). May be `6`, may be distinct.
- `siid 2 piid 2` is **not** an error code. It read `3` all session, then `121`
  while the robot sat docked and healthy, and stayed `3` through a wheel-lift
  stall. Meaning unknown — do not wire it to error detection.
- Whether **Continue Sweep (siid 2 aiid 8)** exists. Untested: invoking an
  unknown aiid moves the robot.
