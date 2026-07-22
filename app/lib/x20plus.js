'use strict';

// Xiaomi Robot Vacuum X20+ (xiaomi.vacuum.c102gl) MIoT map.
// Every value here was observed on firmware 4.5.6_1087 - see FINDINGS.md.
// The published d109gl/X20-Max spec does NOT apply to this model.

const PROPERTIES = [
  { did: 'status', siid: 2, piid: 1 },
  { did: 'charging', siid: 3, piid: 2 },
  { did: 'battery', siid: 3, piid: 1 },
  { did: 'clean_area', siid: 4, piid: 3 }, // m2 cleaned this run (matches the Xiaomi app)
  { did: 'clean_time', siid: 4, piid: 2 }, // minutes elapsed this run
  { did: 'paused_from', siid: 4, piid: 7 }, // what was interrupted (see below)
];

// siid 4 piid 7 is an activity code. Verified live by pausing each activity in
// turn: only this field differs between the two kinds of pause.
//   0 = returning to dock, 1 = cleaning, 6 = paused mid-clean, 11 = paused mid-return
const PAUSED_FROM = {
  CLEANING: 6,
  RETURNING: 11,
  ERROR_RETURNING: 16, // blocked by an obstacle on the way back to the dock
};

const ACTIONS = {
  clean: { siid: 2, aiid: 1 }, // also resumes a paused clean
  pause: { siid: 2, aiid: 2 },
  home: { siid: 3, aiid: 1 }, // also resumes a paused dock-return
};

const STATUS = {
  CLEANING: 1,
  PAUSED: 3,
  ERROR: 4, // blocked and waiting for the user (fault != 0)
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
// cleaning or driving home; siid 4 piid 7 says which (6 vs 11), verified live
// by pausing each activity in turn. Read straight from the robot, no tracking.
function toState(status, pausedFromRaw) {
  switch (status) {
    case STATUS.CLEANING:
      return 'cleaning';
    case STATUS.RETURNING:
      return 'returning';
    case STATUS.PAUSED:
      // Only paused_returning is asserted from a positive match; anything else
      // reads as paused_cleaning (display only - the two resume actions are
      // separate cards the user picks, so this never resumes the wrong task).
      return pausedFromRaw === PAUSED_FROM.RETURNING ? 'paused_returning' : 'paused_cleaning';
    case STATUS.ERROR:
      // Blocked, waiting for the user. 4/7 says what it was doing when it got
      // stuck, so a dock-return blocked by an obstacle is actionable as such.
      return pausedFromRaw === PAUSED_FROM.ERROR_RETURNING ? 'error_returning' : 'error';
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
  error_returning: 'blocked returning to dock',
  error: 'error',
  unknown: 'unknown',
};

// True while the robot is mid-job: cleaning, driving home, or paused doing either.
function isActive(status) {
  // ERROR counts as active: the robot is blocked mid-job, so the running area
  // must be kept rather than reset to 0 while it waits for the user.
  return (
    status === STATUS.CLEANING ||
    status === STATUS.RETURNING ||
    status === STATUS.PAUSED ||
    status === STATUS.ERROR
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
