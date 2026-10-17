import { useEffect, useRef, useState } from 'react';
import { MdArrowForward, MdChatBubbleOutline, MdSearch, MdSmartToy } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import { canSearch, primeCurrentTab, runSearch, submitTask, whenClaimed } from './handoff';

import './taskbox.scss';

const MODES = [
  { id: 'ask', icon: MdChatBubbleOutline },
  { id: 'act', icon: MdSmartToy },
  { id: 'search', icon: MdSearch },
];

const availableModes = () => MODES.filter((mode) => mode.id !== 'search' || canSearch());

const readMode = () => {
  const saved = localStorage.getItem('taskBoxMode');
  return availableModes().some((mode) => mode.id === saved) ? saved : 'ask';
};

function TaskBox() {
  const [mode, setMode] = useState(readMode);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  // True from a successful submit until the side panel has taken the task, so a
  // second task cannot replace it while a cold panel is still starting.
  const [waiting, setWaiting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    primeCurrentTab();
    if (localStorage.getItem('taskBoxFocus') !== 'false') inputRef.current?.focus();
  }, []);

  const onSubmit = (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || waiting) return;
    setError('');

    // Both branches start synchronously inside the submit gesture.
    const run = mode === 'search' ? runSearch(value) : submitTask({ text: value, mode });
    run
      .then(() => {
        if (mode === 'search') return;
        setText('');
        setWaiting(true);
        whenClaimed().then(() => setWaiting(false));
      })
      .catch(() => setError(wbT('wb.panel_failed')));
  };

  return (
    <div className="taskBox">
      <form className="taskBoxForm" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className="taskBoxInput"
          type="text"
          value={text}
          maxLength={4000}
          autoComplete="off"
          spellCheck={false}
          placeholder={wbT(`wb.placeholder_${mode}`)}
          aria-label={wbT(`wb.placeholder_${mode}`)}
          disabled={waiting}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="taskBoxGo" type="submit" aria-label={wbT('wb.go')} disabled={waiting || !text.trim()}>
          <MdArrowForward />
        </button>
      </form>
      <div className="taskBoxModes" role="radiogroup">
        {availableModes().map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? 'taskBoxMode active' : 'taskBoxMode'}
            onClick={() => {
              setMode(id);
              inputRef.current?.focus();
            }}
          >
            <Icon />
            <span>{wbT(`wb.${id}`)}</span>
          </button>
        ))}
      </div>
      {mode === 'act' && <span className="taskBoxHint">{wbT('wb.act_hint')}</span>}
      {error && (
        <span className="taskBoxHint taskBoxError" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default TaskBox;
