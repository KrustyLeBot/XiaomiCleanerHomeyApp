'use strict';

// Endpoints backing the settings page, so the log can be exported from Homey.

function getDevices(homey) {
  return homey.app.homey.drivers.getDriver('x20plus').getDevices();
}

module.exports = {
  async getLog({ homey }) {
    const devices = getDevices(homey);
    if (!devices.length) return { count: 0, csv: '' };

    const device = devices[0];
    return { count: device.getLogCount(), csv: device.getLogCsv() };
  },

  async clearLog({ homey }) {
    for (const device of getDevices(homey)) {
      await device.clearLog();
    }
    return { ok: true };
  },
};
