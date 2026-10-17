/** onKeyDown handler that runs `action` for Enter / Space, for controls that are not <button>s. */
export const onActivateKey = (action) => (event) => {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action(event);
  }
};
