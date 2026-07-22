'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');
const { ACTIONS, STATUS, STATE_NAMES, toState, isActive } = require('../../lib/x20plus');
const { Recorder, WATCHED } = require('../../lib/recorder');
const errlog = require('../../lib/errlog');

const DEFAULT_POLL_SECONDS = 10;
const FAILURES_BEFORE_UNAVAILABLE = 3; // the robot ignores reads while asleep
const FLUSH_INTERVAL = 60000; // batch store writes rather than one per poll
// The robot pauses briefly by itself (~30s observed) and resumes unaided, so a
// pause must persist this long before it is worth notifying about.
const PAUSE_CONFIRM_DELAY = 90000;

class X20PlusDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.lastState = null; // last displayed state, for timeline toggling
    this.cleanedThisCycle = false;
    this.runningArea = 0; // peak area of the in-progress clean

    // Devices paired before a capability was added keep their old capability
    // list (Homey caches it at pairing). Add any missing ones so new features
    // appear without the user having to remove and re-pair the device.
    await this.migrateCapabilities();

    this.recorder = new Recorder(this);

    this.connect();
    this.poll();
    this.startPolling();
    this.flushTimer = this.homey.setInterval(() => this.recorder.flush(), FLUSH_INTERVAL);
  }

  async migrateCapabilities() {
    // The driver's manifest carries the up-to-date capability list from app.json;
    // an old paired device may be missing the newer ones. addCapability inherits
    // the capability definition (units/decimals) from the manifest.
    const manifest = this.driver.manifest || {};
    const wanted = manifest.capabilities || [];

    for (const cap of wanted) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error(`addCapability ${cap}`, err);
          errlog.add(`addCapability ${cap}`, err);
        }
      }
    }
  }

  startPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const seconds = Number(this.getSetting('poll_interval')) || DEFAULT_POLL_SECONDS;
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
  }

  connect() {
    if (this.client) this.client.destroy();
    const { address, token } = this.getSettings();
    this.client = new MiioClient(address, token);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('address') || changedKeys.includes('token')) {
      this.connect();
    }
    if (changedKeys.includes('poll_interval')) {
      // Settings are applied after this returns, so restart on the next tick.
      this.homey.setTimeout(() => this.startPolling(), 100);
    }
  }

  async poll() {
    try {
      // Reads the wide watched set: the extra fields cost nothing in one
      // batched call and are what the recorder needs to catch a recharge.
      const values = await this.client.getProperties(WATCHED);
      if (values.status === undefined) throw new Error('no status in reply');

      this.failures = 0;
      if (!this.getAvailable()) await this.setAvailable();

      this.recorder.record(values);
      await this.update(values);
    } catch (err) {
      this.failures += 1;
      // A single timeout usually just means the robot is asleep.
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        await this.setUnavailable(this.homey.__('unreachable')).catch(() => {});
      }
    }
  }

  async update(values) {
    // The poll uses the recorder's WATCHED set, where fields carry raw dids:
    // status=s2p1? no - status/battery keep names, but area is s4p1 and the
    // pause field is s4p3. Map them here so the rest reads clearly.
    const status = values.status;
    const battery = values.battery;
    const pausedFromRaw = values.s4p3;
    const cleanArea = values.s4p1;

    if (typeof battery === 'number') {
      await this.setCapabilityValue('measure_battery', battery).catch(() => {});
    }

    // Show the running area only while the robot is working; drop to 0 once it
    // is idle/docked, so the Insights graph shows a clear bump per clean rather
    // than holding the last total flat between runs.
    // KNOWN LIMIT: a mid-clean recharge docks (status 6) and reads as idle, so
    // the graph drops to 0 there too - one clean shows as two bumps. Same
    // unresolved case as task_completed; needs a real recharge log.
    if (typeof cleanArea === 'number') {
      const area = isActive(status) ? cleanArea : 0;
      // Log write failures instead of swallowing them, so a broken capability
      // shows up in the app logs rather than a silent "-" on the tile.
      await this.setCapabilityValue('vacuum_clean_area', area).catch((err) => {
        this.error('set vacuum_clean_area', err);
        errlog.add(`set vacuum_clean_area=${area}`, err);
      });

      // Freeze last_cleaned_area on the active -> idle transition, using the
      // last non-zero running value. This does NOT depend on having seen the
      // clean start (cleanedThisCycle), so it survives an app restart that
      // happens mid-clean. runningArea holds the peak while active; when the
      // robot goes idle with a value > 0, that was a real clean that just ended.
      // Freeze only on a real dock arrival (6/13). Transient statuses like 0/2
      // also read as "not active" and would otherwise freeze mid-clean, which
      // reset the running area far too early.
      const atDock = status === STATUS.DOCKED || status === STATUS.CHARGED;
      if (isActive(status)) {
        if (cleanArea > 0) this.runningArea = cleanArea;
      } else if (atDock && this.runningArea > 0) {
        await this.setCapabilityValue('last_cleaned_area', this.runningArea).catch((err) => {
          this.error('set last_cleaned_area', err);
          errlog.add(`set last_cleaned_area=${this.runningArea}`, err);
        });
        this.runningArea = 0;
      }
    }

    const changed = status !== this.lastStatus;
    const previous = this.lastStatus;
    if (changed) this.lastStatus = status;

    // Track whether a real clean happened this cycle. The robot leaves the dock
    // and returns on its own (observed at night, battery full, never cleaning),
    // so "reached dock" alone is not completion - it must have actually cleaned.
    if (status === STATUS.CLEANING) {
      this.cleanedThisCycle = true;
    }

    const state = toState(status, pausedFromRaw);
    await this.setCapabilityValue('vacuum_status', state).catch(() => {});
    await this.setCapabilityValue('vacuum_active', isActive(status)).catch(() => {});

    // Toggle the timeline boolean ONLY when the displayed state actually changes.
    // Doing it every poll would spam the history with the same state on a loop.
    // Tracks state (not raw status): a pause can shift cleaning<->returning while
    // the raw status stays 3.
    const stateChanged = state !== this.lastState;
    this.lastState = state;
    if (stateChanged) await this.updateEventCapabilities(state);

    if (!changed || previous === null) return; // first poll: adopt without firing flows

    await this.fireTriggers(state, status);

    // A clean is finished once the robot is back on the dock after cleaning.
    // KNOWN LIMIT: if the robot recharges mid-clean, it docks with the flag still
    // set and fires once early. Reliable for cleans that finish in one run (the
    // normal case). Needs a real mid-clean-recharge log to tell "docked to
    // recharge" (low battery, leaves again) from "docked, done". See FINDINGS.md.
    // task_completed keeps the cleanedThisCycle guard (must have seen status 1
    // this cycle) so it does NOT fire on the robot's nightly dock wandering.
    // last_cleaned_area is frozen separately above, on the active->idle edge,
    // so it survives an app restart mid-clean where this guard would miss.
    const docked = status === STATUS.DOCKED || status === STATUS.CHARGED;
    if (docked && this.cleanedThisCycle) {
      this.cleanedThisCycle = false;
      await this.toggleEvent('evt_completed');
      await this.homey.flow
        .getDeviceTriggerCard('task_completed')
        .trigger(this, { battery: this.getCapabilityValue('measure_battery') || 0 })
        .catch(this.error);
    }
  }

  // One boolean per display state. Each is a momentary EVENT marker, not a
  // sustained state: entering a state pulses only that one boolean. The others
  // are left untouched, because setting a boolean back to false ALSO creates a
  // timeline entry - which was logging a phantom "started" event on every exit.
  static STATE_EVENT = {
    cleaning: 'evt_cleaning',
    paused_cleaning: 'evt_paused_cleaning',
    returning: 'evt_returning',
    paused_returning: 'evt_paused_returning',
    charging: 'evt_charging',
    docked: 'evt_docked',
    station: 'evt_station',
    unknown: 'evt_unknown',
  };

  // Toggle only the entered state's boolean. The value is meaningless - it is
  // just a marker - so flipping it (true<->false) is a single change, and a
  // single change is one timeline entry. The other booleans are never touched,
  // so no exit ever logs a phantom event.
  async updateEventCapabilities(state) {
    const cap = X20PlusDevice.STATE_EVENT[state];
    if (cap) await this.toggleEvent(cap);
  }

  async toggleEvent(cap) {
    const next = !this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, next).catch(() => {});
  }

  async fireTriggers(state, status) {
    const tokens = {
      status: STATE_NAMES[state] || state,
      battery: this.getCapabilityValue('measure_battery') || 0,
    };

    await this.homey.flow
      .getDeviceTriggerCard('status_changed')
      .trigger(this, tokens)
      .catch(this.error);

    // Pause triggers are delayed: the robot pauses briefly on its own (observed
    // ~30s when it was knocked off the dock and resumed by itself). Firing at
    // once produced a "resume?" notification for a pause that fixed itself.
    // The timer is cancelled below as soon as the state stops being a pause.
    if (state === 'paused_cleaning' || state === 'paused_returning') {
      // pauseNotified keeps it to one notification per pause episode, however
      // many polls the pause spans.
      if (!this.pauseTimer && !this.pauseNotified) {
        this.pauseTimer = this.homey.setTimeout(() => {
          this.pauseTimer = null;
          // Re-check: only notify if still paused in the same way.
          if (this.getCapabilityValue('vacuum_status') !== state) return;
          this.pauseNotified = true;
          this.homey.flow.getDeviceTriggerCard(state).trigger(this, tokens).catch(this.error);
        }, PAUSE_CONFIRM_DELAY);
      }
    } else {
      // Left the pause: cancel a pending notification and re-arm for next time.
      if (this.pauseTimer) {
        this.homey.clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      this.pauseNotified = false;
    }

    // No "cleaning complete" trigger: this firmware exposes no job-pending flag,
    // so a mid-clean recharge is indistinguishable from a finished job. Any such
    // trigger would fire falsely every time the robot tops up. See FINDINGS.md.
  }

  // --- actions ---

  async runAction(action) {
    await this.client.action(action.siid, action.aiid);
  }

  // Same MIoT action as resumeCleaning: from the dock it starts a new job,
  // from a paused clean it continues. Exposed separately so flows read clearly.
  async startCleaning() {
    await this.runAction(ACTIONS.clean);
  }

  async resumeCleaning() {
    await this.runAction(ACTIONS.clean);
  }

  async resumeReturning() {
    await this.runAction(ACTIONS.home);
  }

  async pause() {
    await this.runAction(ACTIONS.pause);
  }

  // --- log export (used by the app settings page) ---

  getLogCsv() {
    return this.recorder.toCsv();
  }

  getLogCount() {
    return this.recorder.count;
  }

  async clearLog() {
    await this.recorder.clear();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.flushTimer) this.homey.clearInterval(this.flushTimer);
    if (this.pauseTimer) this.homey.clearTimeout(this.pauseTimer);
    await this.recorder.flush();
    if (this.client) this.client.destroy();
  }
}

module.exports = X20PlusDevice;
