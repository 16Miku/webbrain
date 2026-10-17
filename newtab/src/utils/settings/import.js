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
import { normalizeLinkUrl } from 'utils/links/normalizeLinkUrl';
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
    const problem = validateSettings(content);
    if (problem) throw new Error(`invalid settings: ${problem}`);
    // Dropping a bad record quietly would still clear the gallery and report success.
    if (backgrounds !== undefined && !isBackgroundList(backgrounds)) {
      throw new Error(`invalid settings: ${BACKGROUNDS_BACKUP_KEY} has an entry of the wrong shape`);
    }
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

// Settings the widgets JSON.parse on load. A wrong value here would not fail the import (every
// write succeeds) but would crash the page on the next load, so check them up front.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
// Delete and drag-and-drop identify these entries by `key`, so it has to be there (and unique).
const hasKey = (e) => (isString(e.key) && e.key !== '') || Number.isFinite(e.key);
const KEYED_LISTS = ['applinks', 'quicklinks'];
// Links are rendered as hrefs, so they get the same http(s) policy as adding or editing one.
const isLinkEntry = (e) =>
  isObject(e) && isString(e.name) && isString(e.url) && normalizeLinkUrl(e.url) !== null && hasKey(e);
// key -> what every entry of the list must look like (the widgets read these fields unguarded)
const JSON_ARRAY_ENTRIES = {
  applinks: isLinkEntry,
  backgroundExclude: isString,
  customEvents: (e) => isObject(e) && isString(e.name) && Number.isFinite(e.month) && Number.isFinite(e.date),
  quicklinks: isLinkEntry,
  messages: isString,
  order: isString,
  todo: (e) => isObject(e) && isString(e.value),
};

/** Returns a reason when the backup would leave the new tab unable to load, else null. */
export function validateSettings(content) {
  for (const [key, value] of Object.entries(content)) {
    if (value !== null && typeof value === 'object') return `${key} is not a plain value`;
  }
  for (const [key, isValidEntry] of Object.entries(JSON_ARRAY_ENTRIES)) {
    if (!(key in content)) continue;
    let list;
    try {
      list = JSON.parse(content[key]);
    } catch {
      return `${key} is not valid JSON`;
    }
    if (!Array.isArray(list)) return `${key} is not a list`;
    if (!list.every(isValidEntry)) return `${key} has an entry of the wrong shape`;
    if (KEYED_LISTS.includes(key) && new Set(list.map((e) => String(e.key))).size !== list.length) {
      return `${key} has entries that share a key`;
    }
  }
  if ('favourite' in content && content.favourite !== 'null') {
    try {
      const favourite = JSON.parse(content.favourite);
      if (favourite !== null && (typeof favourite !== 'object' || Array.isArray(favourite))) {
        return 'favourite is not an object';
      }
    } catch {
      return 'favourite is not valid JSON';
    }
  }
  return null;
}

const isBackgroundList = (list) =>
  Array.isArray(list) && list.every((record) => isObject(record) && typeof record.url === 'string' && record.url.trim() !== '');

const withoutId = ({ id: _id, ...record }) => record; // ids are assigned again

/** Replaces the gallery with `incoming`; resolves to a function that puts the old one back. */
async function replaceBackgrounds(incoming) {
  const records = incoming.map(withoutId); // already validated by isBackgroundList

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
