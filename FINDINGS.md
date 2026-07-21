# X20+ (xiaomi.vacuum.c102gl) — probed facts

Firmware `4.5.6_1087`, probed live over local miIO on 192.168.1.36.
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

## The single-resume question: answered NO

A "resume whatever you were doing" action is **not implementable** on this
firmware. Pausing a clean and pausing a dock-return both yield status `3` with
charging `2`. No readable property retains which activity was interrupted.

Settled by direct test: robot sent home (status 5, charging 5), then paused via
aiid 2. It went to `status=3 charging=2` and held there for 30 s with no
flicker — byte-identical to a paused clean.

Rejected hypothesis: charging `5` looked like a "was docking" marker, since one
log showed `3`/`5` together. That sample was the robot briefly resuming its
drive, not intent being retained. `charging=5` only ever accompanies `status=5`
(actively driving home).

Tracking the previous status in app memory was considered and rejected: it
breaks across Homey restarts and whenever the robot is driven from the Xiaomi
app, and a wrong guess sends the robot the wrong way. Two explicit actions are
honest; a guess dressed as intelligence is not.

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

- `siid 4 piid 7` looked promising (0 -> 1 when cleaning starts) but drops back
  to 0 as soon as the robot leaves the floor. It means "cleaning right now",
  which status already says.
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

## Still open

- Value for a **normally completed** clean (every test run was stopped
  manually). May be `6`, may be distinct.
- `siid 2 piid 2` is **not** an error code. It read `3` all session, then `121`
  while the robot sat docked and healthy, and stayed `3` through a wheel-lift
  stall. Meaning unknown — do not wire it to error detection.
- Whether **Continue Sweep (siid 2 aiid 8)** exists. Untested: invoking an
  unknown aiid moves the robot.
