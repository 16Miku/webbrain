import { saveFile } from 'utils/saveFile';
import variables from 'config/variables';
import { toast } from 'react-toastify';
import { getAllBackgroundsWithMetadata, getBackgroundCount } from 'utils/customBackgroundDB';

// Reserved key in the backup file for the uploaded images / videos, which live in IndexedDB
// (localStorage only keeps their count), so a backup without it would silently lose them.
export const BACKGROUNDS_BACKUP_KEY = 'wbBackgroundsBackup';

/**
 * It takes all the settings from localStorage, plus the uploaded backgrounds, and saves them to a file
 */
export async function exportSettings() {
  const settings = {};

  Object.keys(localStorage).forEach((key) => {
    settings[key] = localStorage.getItem(key);
  });

  try {
    // getBackgroundCount() rejects on failure, whereas getAllBackgroundsWithMetadata() turns
    // a failure into []; an unreadable store must not be written to the backup as "empty".
    const count = await getBackgroundCount();
    const backgrounds = count > 0 ? await getAllBackgroundsWithMetadata() : [];
    if (backgrounds.length !== count) throw new Error('uploaded backgrounds could not be read');
    // Written even when empty: importing such a backup then clears the target profile's
    // uploads, restoring the backed-up state. ids are assigned again on import.
    settings[BACKGROUNDS_BACKUP_KEY] = backgrounds.map(({ id: _id, ...rest }) => rest);
  } catch (error) {
    // A file without the uploads would look like a good backup and lose them on reset or
    // reinstall, so don't write one at all.
    console.error('Could not include uploaded backgrounds in the backup:', error);
    toast(variables.getMessage('toasts.error'));
    return false;
  }

  const date = new Date();
  // Format the date as YYYY-MM-DD_HH-MM-SS
  const formattedDate = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}-${date.getMinutes().toString().padStart(2, '0')}-${date.getSeconds().toString().padStart(2, '0')}`;
  const filename = `webbrain_newtab_settings_backup_${formattedDate}.json`;
  saveFile(settings, filename);
  variables.stats.postEvent('tab', 'Settings exported');
  return true;
}
