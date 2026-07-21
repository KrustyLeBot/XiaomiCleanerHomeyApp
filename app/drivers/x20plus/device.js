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
    const { status, battery, paused_from: pausedFromRaw } = values;

    if (typeof battery === 'number') {
      await this.setCapabilityValue('measure_battery', battery).catch(() => {});
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

    if (!changed || previous === null) return; // first poll: adopt without firing flows

    await this.fireTriggers(state, status);

    // A clean is finished once the robot is back on the dock after cleaning.
    const docked = status === STATUS.DOCKED || status === STATUS.CHARGED;
    if (docked && this.cleanedThisCycle) {
      this.cleanedThisCycle = false;
      await this.homey.flow
        .getDeviceTriggerCard('task_completed')
        .trigger(this, { battery: this.getCapabilityValue('measure_battery') || 0 })
        .catch(this.error);
    }
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

  // Same MIoT action as resumeCleaning: from the dock it starts a new job,
  // from a paused clean it continues. Exposed separately so flows read clearly.
  async startCleaning() {
    await this.client.action(ACTIONS.clean.siid, ACTIONS.clean.aiid);
  }

  async resumeCleaning() {
    await this.client.action(ACTIONS.clean.siid, ACTIONS.clean.aiid);
  }

  async resumeReturning() {
    await this.client.action(ACTIONS.home.siid, ACTIONS.home.aiid);
  }

  async pause() {
    await this.client.action(ACTIONS.pause.siid, ACTIONS.pause.aiid);
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
