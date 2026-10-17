import { toast } from 'react-toastify';
import variables from 'config/variables';
import {
  addBackground,
  clearAllBackgrounds,
  getAllBackgroundsWithMetadata,
  getBackgroundCount,
} from 'utils/customBackgroundDB';
import EventBus from 'utils/eventbus';
import { rawStorage } from 'lib/storage-namespace';
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

  // Everything below is all-or-nothing. Uploaded images / videos live in IndexedDB and the
  // backup replaces them; settings go to localStorage, which can hit its quota part-way.
  // On any failure both stores are put back and the user is told, instead of being left
  // with a half-imported profile.
  let restoreGallery = null;
  const previousValues = new Map();
  try {
    if (Array.isArray(backgrounds)) restoreGallery = await replaceBackgrounds(backgrounds);

    Object.keys(content).forEach((key) => {
      if (!previousValues.has(key)) previousValues.set(key, localStorage.getItem(key));
      localStorage.setItem(key, content[key]);
    });
  } catch (error) {
    console.error('Settings import failed, rolling back:', error);
    previousValues.forEach((value, key) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // nothing more to do for this key
      }
    });
    if (restoreGallery) await restoreGallery();
    toast(variables.getMessage('toasts.error'));
    return false;
  }

  toast(variables.getMessage('toasts.imported'));
  // don't show achievements on welcome
  if (!initial) {
    variables.stats.postEvent('tab', 'Settings imported');
  }

  // Widgets, theme and the settings controls hold the old values in state, so they have to be
  // rebuilt. A reload does that (after the toast has had a moment to show) - unless storage
  // only lives in memory, where a reload would throw the import away: remount instead.
  if (rawStorage) {
    setTimeout(() => window.location.reload(), 1200);
  } else {
    EventBus.emit('settingsimported');
  }
  return true;
}

const withoutId = ({ id: _id, ...record }) => record; // ids are assigned again

/** Replaces the gallery with `incoming`; resolves to a function that puts the old one back. */
async function replaceBackgrounds(incoming) {
  const records = incoming
    .filter((background) => background && typeof background.url === 'string')
    .map(withoutId);

  // getBackgroundCount() rejects on failure; the all-records helper would hide it as [].
  const count = await getBackgroundCount();
  const previous = count > 0 ? (await getAllBackgroundsWithMetadata()).map(withoutId) : [];
  if (previous.length !== count) throw new Error('current gallery could not be read');

  const restore = async () => {
    try {
      await clearAllBackgrounds();
      for (const record of previous) await addBackground(record);
    } catch (rollbackError) {
      console.error('Rollback of the background gallery failed:', rollbackError);
    }
  };

  try {
    await clearAllBackgrounds();
    for (const record of records) await addBackground(record);
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}
