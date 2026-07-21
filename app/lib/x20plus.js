'use strict';

// Xiaomi Robot Vacuum X20+ (xiaomi.vacuum.c102gl) MIoT map.
// Every value here was observed on firmware 4.5.6_1087 - see FINDINGS.md.
// The published d109gl/X20-Max spec does NOT apply to this model.

const PROPERTIES = [
  { did: 'status', siid: 2, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'paused_from', siid: 4, piid: 3 },
  { did: 'clean_area', siid: 4, piid: 1 }, // cleaned area, climbs during a run
];

// siid 4 piid 3 says what the robot was doing when it paused. Observed live:
// the firmware does retain the interrupted activity, contrary to what status
// and charging alone suggest.
const PAUSED_FROM = {
  CLEANING: 6,
  RETURNING: 11,
};

const ACTIONS = {
  clean: { siid: 2, aiid: 1 }, // also resumes a paused clean
  pause: { siid: 2, aiid: 2 },
  home: { siid: 3, aiid: 1 }, // also resumes a paused dock-return
};

const STATUS = {
  CLEANING: 1,
  PAUSED: 3,
  RETURNING: 5,
  DOCKED: 6, // on the dock, still charging
  CHARGED: 13, // on the dock, battery full - resting state
  STATION: 22, // brief post-dock station cycle
};

const CHARGING = {
  ON_DOCK: 1,
  OFF_DOCK: 2,
  RETURNING: 5,
};

// User-facing state. The robot reports a single "paused" (3) whether it was
// cleaning or driving home, so pausedFrom - tracked by the device from the
// previous status - is what splits it into the two states that matter.
function toState(status, pausedFromRaw, pausedFromTracked) {
  switch (status) {
    case STATUS.CLEANING:
      return 'cleaning';
    case STATUS.RETURNING:
      return 'returning';
    case STATUS.PAUSED:
      // Prefer what the robot reports; fall back to the tracked previous
      // status only if the field is missing or carries an unseen value.
      if (pausedFromRaw === PAUSED_FROM.RETURNING) return 'paused_returning';
      if (pausedFromRaw === PAUSED_FROM.CLEANING) return 'paused_cleaning';
      return pausedFromTracked === 'returning' ? 'paused_returning' : 'paused_cleaning';
    case STATUS.DOCKED:
      return 'charging';
    case STATUS.CHARGED:
      // The robot reports a distinct value when full, rather than reusing 6.
      return 'docked';
    case STATUS.STATION:
      return 'station';
    default:
      return 'unknown';
  }
}

const STATE_NAMES = {
  cleaning: 'cleaning',
  paused_cleaning: 'cleaning paused',
  returning: 'returning to dock',
  paused_returning: 'return to dock paused',
  charging: 'charging',
  docked: 'docked',
  station: 'station working',
  unknown: 'unknown',
};

// True while the robot is mid-job: cleaning, driving home, or paused doing either.
function isActive(status) {
  return (
    status === STATUS.CLEANING || status === STATUS.RETURNING || status === STATUS.PAUSED
  );
}

module.exports = {
  PROPERTIES,
  ACTIONS,
  STATUS,
  CHARGING,
  PAUSED_FROM,
  STATE_NAMES,
  toState,
  isActive,
};
