import { toast } from 'react-toastify';
import variables from 'config/variables';
import {
  addBackground,
  clearAllBackgrounds,
  getAllBackgroundsWithMetadata,
  getBackgroundCount,
} from 'utils/customBackgroundDB';
import { BACKGROUNDS_BACKUP_KEY } from './export';

/**
 * It takes a JSON file of Mue settings, parses it, and then sets the localStorage values to the values in the
 * file.
 * @param e - The JSON settings string to import
 */
export async function importSettings(e, initial = false) {
  let backgrounds;
  let content;
  try {
    const parsed = JSON.parse(e);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings file is not an object');
    }
    ({ [BACKGROUNDS_BACKUP_KEY]: backgrounds, ...content } = parsed);
  } catch (error) {
    // Truncated or foreign file: say so, and change nothing.
    console.error('Could not read the settings file:', error);
    toast(variables.getMessage('toasts.error'));
    return false;
  }

  // Uploaded images / videos live in IndexedDB; the backup replaces what is there. This goes
  // first and is all-or-nothing: if it fails the current gallery is put back and nothing else
  // is imported, rather than reporting success for a half-restored profile.
  if (Array.isArray(backgrounds)) {
    try {
      await replaceBackgrounds(backgrounds);
    } catch (error) {
      console.error('Could not restore uploaded backgrounds:', error);
      toast(variables.getMessage('toasts.error'));
      return false;
    }
  }

  Object.keys(content).forEach((key) => {
    localStorage.setItem(key, content[key]);
  });

  toast(variables.getMessage('toasts.imported'));
  // don't show achievements on welcome
  if (!initial) {
    variables.stats.postEvent('tab', 'Settings imported');
  }

  // Widgets, theme and the settings controls hold the old values in state; a reload (after
  // the toast has had a moment to show) is what applies the imported ones.
  setTimeout(() => window.location.reload(), 1200);
  return true;
}

const withoutId = ({ id: _id, ...record }) => record; // ids are assigned again

async function replaceBackgrounds(incoming) {
  const records = incoming
    .filter((background) => background && typeof background.url === 'string')
    .map(withoutId);

  // getBackgroundCount() rejects on failure; the all-records helper would hide it as [].
  const count = await getBackgroundCount();
  const previous = count > 0 ? (await getAllBackgroundsWithMetadata()).map(withoutId) : [];
  if (previous.length !== count) throw new Error('current gallery could not be read');

  try {
    await clearAllBackgrounds();
    for (const record of records) await addBackground(record);
  } catch (error) {
    // Roll back to what the user had.
    try {
      await clearAllBackgrounds();
      for (const record of previous) await addBackground(record);
    } catch (rollbackError) {
      console.error('Rollback of the background gallery failed:', rollbackError);
    }
    throw error;
  }
}
