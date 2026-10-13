// Models may populate an optional callback with empty schema placeholders.
// Share this definition between application and permission checks so an unused
// callback cannot block cookie/field/click bindings or request extra capability.
export function isEmptyCaptchaCallback(callback) {
  return callback !== null && typeof callback === 'object' && !Array.isArray(callback)
    && Object.keys(callback).every(key => key === 'name' || key === 'path')
    && [callback.name, callback.path].every(value => value == null
      || (typeof value === 'string' && value.trim() === ''));
}
