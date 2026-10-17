// Mue kept local usage counters to unlock achievements. WebBrain's new tab
// keeps nothing: the call sites remain (so upstream merges stay small) but
// every method is a no-op.
export default class Stats {
  static async postEvent() {}
  static async tabLoad() {}
}
