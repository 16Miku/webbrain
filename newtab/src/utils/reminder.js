import EventBus from 'utils/eventbus';

/**
 * Shows the "reload to apply" notice in the settings modal. The notice component only
 * exists while the modal's reminder state is on, so besides storing the flag this tells the
 * modal (EventBus 'reminder') to turn that state on; the element is also updated directly if
 * it is already mounted.
 */
export function showReloadReminder() {
  localStorage.setItem('showReminder', true);
  const el = document.querySelector('.reminder-info');
  if (el) el.style.display = 'flex';
  EventBus.emit('reminder');
}
