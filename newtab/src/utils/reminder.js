/**
 * Shows the "reload to apply" notice in the settings modal. The notice is only in
 * the DOM while the modal's reminder state is on, so it may not exist yet; storing
 * the flag is what makes it appear next time, and the element is updated only if it
 * is already there.
 */
export function showReloadReminder() {
  const el = document.querySelector('.reminder-info');
  if (el) el.style.display = 'flex';
  localStorage.setItem('showReminder', true);
}
