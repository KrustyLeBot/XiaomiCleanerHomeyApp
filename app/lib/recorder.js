'use strict';

// Rolling log of raw MIoT values, kept so a real mid-clean recharge can be
// captured and analysed later. The firmware exposes no "job pending" flag, so
// the only way to find one is to record everything during an actual recharge.

const MAX_ENTRIES = 3000; // ~8h at one entry per 10s, bounded for Homey storage
const STORE_KEY = 'recharge_log';

// Wider than the app needs at runtime: these are the fields that plausibly
// encode job state. Recorded so the log is useful without a second session.
const WATCHED = [
  { did: 'status', siid: 2, piid: 1 },
  { did: 'fault', siid: 2, piid: 2 },
  { did: 's2p5', siid: 2, piid: 5 },
  { did: 's2p6', siid: 2, piid: 6 },
  { did: 's2p8', siid: 2, piid: 8 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 's4p1', siid: 4, piid: 1 },
  { did: 's4p3', siid: 4, piid: 3 },
  { did: 's4p7', siid: 4, piid: 7 },
  { did: 's4p16', siid: 4, piid: 16 },
  { did: 's4p17', siid: 4, piid: 17 }, // 1 while docked to recharge mid-clean
  { did: 's4p18', siid: 4, piid: 18 },
  { did: 's4p20', siid: 4, piid: 20 },
  { did: 's4p25', siid: 4, piid: 25 },
  { did: 's7p9', siid: 7, piid: 9 },
  { did: 's12p5', siid: 12, piid: 5 },
];

class Recorder {
  constructor(device) {
    this.device = device;
    this.entries = device.getStoreValue(STORE_KEY) || [];
    this.lastSignature = null;
    this.dirty = false;
  }

  get enabled() {
    return this.device.getSetting('logging') !== false;
  }

  // Only records when something changed, so the log stays readable and small.
  record(values) {
    if (!this.enabled) return;

    const signature = JSON.stringify(values);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.entries.push({ t: Date.now(), ...values });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.device.setStoreValue(STORE_KEY, this.entries).catch(() => {});
  }

  async clear() {
    this.entries = [];
    this.lastSignature = null;
    this.dirty = false;
    await this.device.setStoreValue(STORE_KEY, []).catch(() => {});
  }

  // CSV: opens in a spreadsheet, and is easy to paste back for analysis.
  toCsv() {
    const cols = ['t', ...WATCHED.map((w) => w.did)];
    const lines = [cols.join(',')];
    for (const e of this.entries) {
      lines.push(
        cols
          .map((c) => (c === 't' ? new Date(e.t).toISOString() : e[c] === undefined ? '' : e[c]))
          .join(',')
      );
    }
    return lines.join('\n');
  }

  get count() {
    return this.entries.length;
  }
}

module.exports = { Recorder, WATCHED };
