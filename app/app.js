'use strict';

const Homey = require('homey');
const { STATUS } = require('./lib/x20plus');

class X20PlusApp extends Homey.App {
  async onInit() {
    this.registerActions();
    this.registerConditions();
  }

  registerActions() {
    // Two explicit resume actions. There is deliberately no "smart resume":
    // a paused clean and a paused dock-return are indistinguishable on this
    // firmware, and resuming the wrong one starts a full clean of the flat.
    this.homey.flow
      .getActionCard('start_cleaning')
      .registerRunListener(({ device }) => device.startCleaning());

    this.homey.flow
      .getActionCard('resume_cleaning')
      .registerRunListener(({ device }) => device.resumeCleaning());

    this.homey.flow
      .getActionCard('resume_returning')
      .registerRunListener(({ device }) => device.resumeReturning());

    this.homey.flow.getActionCard('pause').registerRunListener(({ device }) => device.pause());
  }

  registerConditions() {
    this.homey.flow
      .getConditionCard('is_paused_from')
      .registerRunListener(({ device, reason }) => device.pausedFrom === reason);

    this.homey.flow
      .getConditionCard('status_is')
      .registerRunListener(({ device, status }) => String(device.lastStatus) === status);
  }
}

module.exports = X20PlusApp;
