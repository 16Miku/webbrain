export const SHORTCUT_COMMAND_STORAGE_KEY = '_wb_cmd';

export const FIREFOX_SHORTCUT_COMMANDS = new Set([
  'switch-to-ask',
  'switch-to-act',
  'switch-to-dev',
  'focus-input',
]);

export function shortcutCommandEnvelope(command, tab, now = Date.now()) {
  const normalizedCommand = String(command || '');
  const windowId = Number(tab?.windowId);
  if (
    !FIREFOX_SHORTCUT_COMMANDS.has(normalizedCommand)
    || !Number.isInteger(windowId)
    || windowId < 0
  ) return null;
  return {
    command: normalizedCommand,
    windowId,
    ts: Math.max(0, Number(now) || 0),
  };
}

export function shortcutCommandForWindow(value, windowId) {
  const normalizedWindowId = Number(windowId);
  if (
    !value
    || typeof value !== 'object'
    || !Number.isInteger(normalizedWindowId)
    || normalizedWindowId < 0
    || value.windowId !== normalizedWindowId
    || !FIREFOX_SHORTCUT_COMMANDS.has(value.command)
  ) return '';
  return value.command;
}
