/**
 * Tiny pub/sub on top of document events.
 *
 * Every subscription keeps the exact function that was passed to
 * addEventListener (and its capture flag), so off() removes the real listener.
 * (Upstream Mue registered an anonymous wrapper and then tried to remove the
 * original callback, so React cleanups did nothing and handlers piled up.)
 */
export default class EventBus {
  static listeners = {};

  static register(event, entry) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    if (entry.first) {
      this.listeners[event].unshift(entry);
    } else {
      this.listeners[event].push(entry);
    }
  }

  /**
   * Subscribes callback to event; it receives the event's detail.
   * @param event - The event name
   * @param callback - The function to be called when the event is triggered.
   */
  static on(event, callback) {
    const listener = (e) => callback(e.detail);
    document.addEventListener(event, listener);
    this.register(event, { callback, listener, capture: false });
  }

  /**
   * It creates a new custom event, and dispatches it
   * @param event - The name of the event you want to emit.
   * @param data - The data you want to pass to the event.
   */
  static emit(event, data) {
    document.dispatchEvent(
      new CustomEvent(event, {
        detail: data,
      }),
    );
  }

  /**
   * Removes the subscription made with this callback (or with this registered listener
   * function, which is what once()/prependOnce() pass).
   * @param event - The event to stop listening for.
   * @param callback - The function that was passed to on()/once()/prepend().
   */
  static off(event, callback) {
    const entries = this.listeners[event] || [];
    const matching = entries.filter(
      (entry) => entry.callback === callback || entry.listener === callback,
    );
    matching.forEach((entry) =>
      document.removeEventListener(event, entry.listener, { capture: entry.capture }),
    );
    this.listeners[event] = entries.filter((entry) => !matching.includes(entry));
  }

  /**
   * Like on(), but unsubscribes itself after the first call.
   */
  static once(event, callback) {
    const listener = (e) => {
      this.off(event, listener);
      callback(e.detail);
    };
    document.addEventListener(event, listener);
    this.register(event, { callback, listener, capture: false });
  }

  /**
   * Like on(), but runs before listeners added without capture.
   */
  static prepend(event, callback) {
    const listener = (e) => callback(e.detail);
    document.addEventListener(event, listener, { capture: true });
    this.register(event, { callback, listener, capture: true, first: true });
  }

  /**
   * prepend() that unsubscribes itself after the first call.
   */
  static prependOnce(event, callback) {
    const listener = (e) => {
      this.off(event, listener);
      callback(e.detail);
    };
    document.addEventListener(event, listener, { capture: true });
    this.register(event, { callback, listener, capture: true, first: true });
  }

  /**
   * The subscriptions for an event, as { callback, listener, capture } entries.
   */
  static getListeners(event) {
    return this.listeners[event] || [];
  }

  /**
   * The names of all events that have subscriptions.
   */
  static eventNames() {
    return Object.keys(this.listeners);
  }

  /**
   * Removes every subscription.
   */
  static removeAllListeners() {
    Object.keys(this.listeners).forEach((event) => {
      this.listeners[event].forEach(({ listener, capture }) => {
        document.removeEventListener(event, listener, { capture });
      });
    });
    this.listeners = {};
  }
}
