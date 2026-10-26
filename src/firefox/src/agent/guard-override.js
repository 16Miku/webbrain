// Explicit command grammar, not a search through prose. Only the caller's
// genuine user-authored message may be passed here; quoted instructions,
// questions and negations do not authorize an action.
export function isExplicitGuardOverrideRequest(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim().replace(/[\t ]+/g, ' ');
  return /^(?:please[, ]+)?(?:override|bypass) (?:(?:that|this|the) )?(?:(?:publication|submission) )?guard(?: (?:now|please))?[.!]*$/i.test(command);
}
