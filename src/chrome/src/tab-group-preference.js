export const AUTO_GROUP_TABS_KEY = 'autoGroupTabs';

export async function shouldAutoGroupTabs(storageArea) {
  if (!storageArea?.get) return true;
  try {
    const stored = await storageArea.get(AUTO_GROUP_TABS_KEY);
    return stored?.[AUTO_GROUP_TABS_KEY] !== false;
  } catch {
    return true;
  }
}
