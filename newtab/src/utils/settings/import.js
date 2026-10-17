import { toast } from 'react-toastify';
import variables from 'config/variables';
import { addBackground, clearAllBackgrounds } from 'utils/customBackgroundDB';
import { BACKGROUNDS_BACKUP_KEY } from './export';

/**
 * It takes a JSON file of Mue settings, parses it, and then sets the localStorage values to the values in the
 * file.
 * @param e - The JSON settings string to import
 */
export async function importSettings(e, initial = false) {
  const { [BACKGROUNDS_BACKUP_KEY]: backgrounds, ...content } = JSON.parse(e);

  Object.keys(content).forEach((key) => {
    localStorage.setItem(key, content[key]);
  });

  // Uploaded images / videos live in IndexedDB; the backup replaces what is there.
  if (Array.isArray(backgrounds)) {
    try {
      await clearAllBackgrounds();
      for (const background of backgrounds) {
        if (background && typeof background.url === 'string') {
          // a stored id would collide with the auto-assigned ones
          const { id: _id, ...record } = background;
          await addBackground(record);
        }
      }
    } catch (error) {
      console.error('Could not restore uploaded backgrounds:', error);
      toast(variables.getMessage('toasts.error'));
    }
  }

  toast(variables.getMessage('toasts.imported'));
  // don't show achievements on welcome
  if (!initial) {
    variables.stats.postEvent('tab', 'Settings imported');
  }

  // Widgets, theme and the settings controls hold the old values in state; a reload (after
  // the toast has had a moment to show) is what applies the imported ones.
  setTimeout(() => window.location.reload(), 1200);
}
