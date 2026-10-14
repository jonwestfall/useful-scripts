// The controller's tabs: which there are, what they are called, and how they
// group (Issue #197). Data only - the tab bar itself is tab-bar.js, and which
// tabs this controller can use where it is stays in control.js.

// The tabs in their four job groups (Issue #197): Present (what is on the
// projector and what is drawn on it), Room (what the room reads and answers),
// Sound, and Setup (what is arranged before class). Camera and Photos belong
// with Present but start under "More" - most lectures never open them.
// Adding a tab here later needs nothing else done to it: an unknown id in a
// saved order is dropped and a new one not yet saved is appended (see
// loadPresentation in presentation-prefs.js).
export const TAB_IDS = ['library', 'slides', 'now', 'ink', 'camera', 'photos', 'say', 'timer', 'polls', 'attendance', 'music', 'mixer', 'setup'];
export const TAB_LABELS = {
  library: 'Library', slides: 'Slides', now: 'Now', ink: 'Ink', camera: 'Camera', photos: 'Photos',
  say: 'Say', timer: 'Timer', polls: 'Polls', attendance: 'Attendance', music: 'Music', mixer: 'Mixer', setup: 'Setup',
};
export const TAB_GROUPS = [
  ['present', 'Present', ['library', 'slides', 'now', 'ink', 'camera', 'photos']],
  ['room', 'Room', ['say', 'timer', 'polls', 'attendance']],
  ['sound', 'Sound', ['music', 'mixer']],
  ['setup', 'Setup', ['setup']],
];
export const groupOfTab = (id) => TAB_GROUPS.find(([, , ids]) => ids.includes(id))?.[0];
export const DEFAULT_HIDDEN_TABS = ['camera', 'photos'];
// Bumped when the default arrangement itself changes, so a device that saved
// the old one (12 tabs, in a different order) is moved onto the new one once.
export const TAB_LAYOUT_VERSION = 2;
