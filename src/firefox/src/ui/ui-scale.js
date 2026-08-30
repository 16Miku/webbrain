export const UI_SCALE_STORAGE_KEY = 'uiScale';
export const UI_SCALE_LOCAL_STORAGE_KEY = 'wbUiScale';
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_LEVELS = Object.freeze([75, 80, 90, 100, 110, 125, 150, 175]);

export function normalizeUiScale(value) {
  const numeric = Number(value);
  return UI_SCALE_LEVELS.includes(numeric) ? numeric : UI_SCALE_DEFAULT;
}

export function stepUiScale(value, direction) {
  const current = normalizeUiScale(value);
  const index = UI_SCALE_LEVELS.indexOf(current);
  const offset = Number(direction) < 0 ? -1 : 1;
  const nextIndex = Math.max(0, Math.min(UI_SCALE_LEVELS.length - 1, index + offset));
  return UI_SCALE_LEVELS[nextIndex];
}

export function uiScaleLayout(value) {
  const scale = normalizeUiScale(value);
  const inverse = Number((10_000 / scale).toFixed(4));
  return {
    scale,
    zoom: scale / 100,
    width: `${inverse}%`,
    height: `${inverse}vh`,
  };
}

export function uiScaleShortcutAction(event) {
  if (
    event?.isComposing
    || event?.altKey
    || event?.getModifierState?.('AltGraph')
    || (!event?.ctrlKey && !event?.metaKey)
  ) return '';

  if (event.code === 'Equal' || event.code === 'NumpadAdd' || event.key === '+' || event.key === '=') {
    return 'increase';
  }
  if (event.code === 'Minus' || event.code === 'NumpadSubtract' || event.key === '-') {
    return 'decrease';
  }
  if (event.code === 'Digit0' || event.code === 'Numpad0' || event.key === '0') {
    return 'reset';
  }
  return '';
}

export async function loadUiScale(storage) {
  try {
    const stored = await storage?.get?.(UI_SCALE_STORAGE_KEY);
    return normalizeUiScale(stored?.[UI_SCALE_STORAGE_KEY]);
  } catch {
    return UI_SCALE_DEFAULT;
  }
}

export async function saveUiScale(storage, value) {
  const scale = normalizeUiScale(value);
  await storage?.set?.({ [UI_SCALE_STORAGE_KEY]: scale });
  return scale;
}

export function applyUiScale(root, value, localStore = globalThis.localStorage) {
  const layout = uiScaleLayout(value);
  root?.style?.setProperty?.('--ui-scale-zoom', String(layout.zoom));
  root?.style?.setProperty?.('--ui-scale-width', layout.width);
  root?.style?.setProperty?.('--ui-scale-height', layout.height);
  if (root?.dataset) root.dataset.uiScale = String(layout.scale);
  try {
    localStore?.setItem?.(UI_SCALE_LOCAL_STORAGE_KEY, String(layout.scale));
  } catch {
    // Storage mirroring is only a pre-paint optimization.
  }
  return layout.scale;
}
