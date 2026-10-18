import variables from 'config/variables';
import { memo, useState, useCallback } from 'react';

import EventBus from 'utils/eventbus';

import './Switch.scss';
import { showReloadReminder } from 'utils/reminder';

const Switch = memo((props) => {
  const [checked, setChecked] = useState(localStorage.getItem(props.name) === 'true');

  const handleChange = useCallback(() => {
    const value = !checked;
    localStorage.setItem(props.name, value);
    setChecked(value);

    if (props.onChange) {
      props.onChange(value);
    }

    variables.stats.postEvent(
      'setting',
      `${props.name} ${checked ? 'enabled' : 'disabled'}`,
    );

    if (props.element) {
      if (!document.querySelector(props.element)) {
        showReloadReminder();
        return;
      }
    }

    EventBus.emit('refresh', props.category);
  }, [checked, props]);

  // The native checkbox is the control (focusable, announced, Space toggles it) and the
  // visible track is its decoration; the label text names it.
  const label = props.text || props.title || props.name;
  return (
    <div className="switch-wrapper">
      {!props.header && <span className="switch-label">{props.text}</span>}
      <div
        className={`switch-track ${checked ? 'checked' : ''}`}
        onClick={handleChange}
        aria-hidden="true"
      >
        <div className="switch-thumb" />
      </div>
      <input
        type="checkbox"
        role="switch"
        name={props.name}
        checked={checked}
        onChange={handleChange}
        className="switch-input"
        aria-label={label}
      />
    </div>
  );
});

Switch.displayName = 'Switch';

export { Switch as default, Switch };
