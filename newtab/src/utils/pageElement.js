// The part of the page react-modal hides from assistive technology while a dialog is open:
// everything except the toast container (which sits beside #center and has to stay readable).
// Looked up on every render because #center is remounted when the profile is first set up.
export const pageElement = () =>
  (typeof document !== 'undefined' && document.getElementById('center')) || undefined;
