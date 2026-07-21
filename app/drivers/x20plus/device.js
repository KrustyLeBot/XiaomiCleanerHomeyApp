'use strict';

const Homey = require('homey');
const MiioClient = require('../../lib/miio-client');
const { ACTIONS, STATUS, STATE_NAMES, toState, isActive } = require('../../lib/x20plus');
const { Recorder, WATCHED } = require('../../lib/recorder');

const DEFAULT_POLL_SECONDS = 10;
const FAILURES_BEFORE_UNAVAILABLE = 3; // the robot ignores reads while asleep
const FLUSH_INTERVAL = 60000; // batch store writes rather than one per poll

class X20PlusDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.lastStatus = null;
    this.cleanedThisCycle = false;
    this.runningArea = 0; // peak area of the in-progress clean
    // What the robot was doing before it paused. The firmware forgets this, so
    // we track it ourselves to label the pause notification.
    this.pausedFrom = null;

    this.recorder = new Recorder(this);

    this.connect();
    this.poll();
    this.startPolling();
    this.flushTimer = this.homey.setInterval(() => this.recorder.flush(), FLUSH_INTERVAL);
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
    const { status, battery, paused_from: pausedFromRaw, clean_area: cleanArea } = values;

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
      await this.setCapabilityValue('vacuum_clean_area', area).catch(() => {});
      // Remember the running area so it can be frozen into last_cleaned_area
      // when the clean finishes (the live value resets to 0 on the next run).
      if (isActive(status) && cleanArea > 0) this.runningArea = cleanArea;
    }

    // Work out the pause context first - the displayed state depends on it.
    const changed = status !== this.lastStatus;
    const previous = this.lastStatus;

    if (changed) {
      if (status === STATUS.PAUSED) {
        // Keep an existing reason on restart: previous is null then, and
        // guessing "cleaning" would mislabel a paused dock-return.
        if (previous !== null) {
          this.pausedFrom = previous === STATUS.RETURNING ? 'returning' : 'cleaning';
        }
      } else {
        this.pausedFrom = null;
      }
      this.lastStatus = status;
    }

    // Track whether a real clean happened this cycle. The robot leaves the dock
    // and returns on its own (observed at night, battery full, never cleaning),
    // so "reached dock" alone is not completion - it must have actually cleaned.
    if (status === STATUS.CLEANING) {
      this.cleanedThisCycle = true;
    }

    const state = toState(status, pausedFromRaw, this.pausedFrom);
    await this.setCapabilityValue('vacuum_status', state).catch(() => {});
    await this.setCapabilityValue('vacuum_active', isActive(status)).catch(() => {});

    // Drive the hidden boolean "event" capabilities. Homey's native device
    // Timeline records boolean changes automatically, giving a per-device
    // history tab - the enum capability alone gets no timeline.
    await this.updateEventCapabilities(state);

    if (!changed || previous === null) return; // first poll: adopt without firing flows

    await this.fireTriggers(state, status);

    // A clean is finished once the robot is back on the dock after cleaning.
    // KNOWN LIMIT: if the robot recharges mid-clean, it docks with the flag still
    // set and fires once early. Reliable for cleans that finish in one run (the
    // normal case). Needs a real mid-clean-recharge log to tell "docked to
    // recharge" (low battery, leaves again) from "docked, done". See FINDINGS.md.
    const docked = status === STATUS.DOCKED || status === STATUS.CHARGED;
    if (docked && this.cleanedThisCycle) {
      this.cleanedThisCycle = false;

      // Freeze the area of the clean that just finished. Kept until the next
      // clean overwrites it, unlike vacuum_clean_area which drops back to 0.
      if (this.runningArea > 0) {
        await this.setCapabilityValue('last_cleaned_area', this.runningArea).catch(() => {});
        this.runningArea = 0;
      }

      await this.pulseEvent('evt_completed');
      await this.homey.flow
        .getDeviceTriggerCard('task_completed')
        .trigger(this, { battery: this.getCapabilityValue('measure_battery') || 0 })
        .catch(this.error);
    }
  }

  // One boolean per display state - the full set, so every state shows on the
  // native timeline. true while in the state, false otherwise, so each entry
  // marks when the state began and ended.
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

  async updateEventCapabilities(state) {
    const active = X20PlusDevice.STATE_EVENT[state];
    for (const cap of Object.values(X20PlusDevice.STATE_EVENT)) {
      const value = cap === active;
      if (this.getCapabilityValue(cap) !== value) {
        await this.setCapabilityValue(cap, value).catch(() => {});
      }
    }
  }

  // A momentary event (no lasting state): flip true then back to false so the
  // timeline gets a single mark.
  async pulseEvent(cap) {
    await this.setCapabilityValue(cap, true).catch(() => {});
    this.homey.setTimeout(() => this.setCapabilityValue(cap, false).catch(() => {}), 1000);
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

    // Driven by the same state shown in the UI, so they can never disagree.
    if (state === 'paused_cleaning' || state === 'paused_returning') {
      await this.homey.flow.getDeviceTriggerCard(state).trigger(this, tokens).catch(this.error);
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
    await this.recorder.flush();
    if (this.client) this.client.destroy();
  }
}

module.exports = X20PlusDevice;
