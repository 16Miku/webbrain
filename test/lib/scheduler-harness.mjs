export function makeSchedulerHarness(SchedulerMod, opts = {}) {
  const store = {
    [SchedulerMod.SCHEDULED_JOBS_KEY]: opts.jobs ? structuredClone(opts.jobs) : [],
    [SchedulerMod.SCHEDULED_TASKS_ENABLED_KEY]: opts.enabled ?? true,
    [SchedulerMod.SCHEDULED_REQUIRE_CONFIRMATION_KEY]: opts.requireConfirmation ?? true,
    typesafeApiKey: opts.systemOneApiKey ?? '',
    systemOneEnabled: opts.systemOneEnabled ?? false,
    systemOneWatchEnabled: opts.systemOneWatchEnabled ?? false,
    systemOneCompletionEnabled: opts.systemOneCompletionEnabled ?? false,
    systemOneWatchThreshold: opts.systemOneWatchThreshold ?? 0.7,
    systemOneCompletionThreshold: opts.systemOneCompletionThreshold ?? 0.7,
    strictSecretMode: opts.strictSecretMode ?? false,
  };
  const cloneStoredValue = (value) => value == null ? value : structuredClone(value);
  const alarms = new Map();
  const updates = [];
  let currentNow = opts.now ?? Date.UTC(2026, 0, 1, 12, 0, 0);
  const tabs = new Map([[77, { id: 77, url: 'https://example.com/', title: 'Example' }]]);
  let nextTabId = 100;

  const api = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, cloneStoredValue(store[key])]));
          }
          if (typeof keys === 'string') return { [keys]: cloneStoredValue(store[keys]) };
          return Object.fromEntries(Object.entries(store).map(([key, value]) => [key, cloneStoredValue(value)]));
        },
        async set(values) {
          Object.assign(store, Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, cloneStoredValue(value)])
          ));
        },
      },
    },
    alarms: {
      async create(name, spec) { alarms.set(name, spec); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener() {} },
    },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        return tabs.get(tabId);
      },
      async update(tabId, changes) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        const tab = { ...tabs.get(tabId), ...changes };
        tabs.set(tabId, tab);
        return tab;
      },
      async create({ url, active }) {
        const tab = { id: nextTabId++, url, active: !!active };
        tabs.set(tab.id, tab);
        return tab;
      },
      async remove(tabId) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        tabs.delete(tabId);
      },
    },
  };

  const agent = {
    isRunning: opts.isRunning || (() => false),
    getConversationId: opts.getConversationId || (async () => 'conv-1'),
    requireExplicitClarificationAuthorization: opts.requireExplicitClarificationAuthorization || (async () => {}),
    processMessage: opts.processMessage || (async () => 'scheduled result'),
    abort: opts.abort || (() => {}),
    setScheduledRunPolicy: opts.setScheduledRunPolicy || (() => {}),
    clearScheduledRunPolicy: opts.clearScheduledRunPolicy || (() => {}),
  };

  const manager = new SchedulerMod.ScheduledJobManager({
    api,
    agent,
    loadProviders: async () => {},
    sendUpdate(tabId, type, data) { updates.push({ tabId, type, data }); },
    showIndicator() {},
    hideIndicator() {},
    playWatchAlert: opts.playWatchAlert || (async () => {}),
    ...(opts.systemOneJudge ? { systemOneJudge: opts.systemOneJudge } : {}),
    now: () => currentNow,
    ...(opts.startAlarmKeepAlive ? { startAlarmKeepAlive: opts.startAlarmKeepAlive } : {}),
  });

  return {
    manager,
    alarms,
    tabs,
    updates,
    jobs: () => store[SchedulerMod.SCHEDULED_JOBS_KEY],
    setNow: (value) => { currentNow = value; },
    alarmName: (jobId) => `${SchedulerMod.SCHEDULED_ALARM_PREFIX}${jobId}`,
  };
}

