import { useState, useEffect, useRef } from 'react';
import EventBus from 'utils/eventbus';
import './message.scss';

const readMessages = () => {
  try {
    const list = JSON.parse(localStorage.getItem('messages'));
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item !== '') : [];
  } catch {
    return [];
  }
};

const Message = () => {
  const [messageText, setMessageText] = useState('');
  const [display, setDisplay] = useState('none');
  const [fontSize, setFontSize] = useState('1em');
  const message = useRef();

  useEffect(() => {
    const handleRefresh = (data) => {
      if (data === 'message') {
        // The list may have changed (entry removed): keep the shown text only if it is still
        // there, otherwise pick another one or show nothing.
        const messages = readMessages();
        setMessageText((current) => {
          if (messages.includes(current)) return current;
          return messages.length > 0 ? messages[Math.floor(Math.random() * messages.length)] : '';
        });
        const messageSetting = localStorage.getItem('message');
        const zoomMessage = localStorage.getItem('zoomMessage');
        setDisplay(messageSetting === 'false' || messages.length === 0 ? 'none' : 'block');
        setFontSize(`${1 * Number((zoomMessage || 100) / 100)}em`);
      }
    };

    const messages = readMessages();
    if (messages.length > 0) {
      setMessageText(messages[Math.floor(Math.random() * messages.length)]);
      setDisplay('block');
    }

    EventBus.on('refresh', handleRefresh);
    return () => {
      EventBus.off('refresh', handleRefresh);
    };
  }, []);

  return (
    <h2 className="message" ref={message} style={{ display, fontSize }}>
      {messageText.split('\\n').map((item) => (
        <span key={item}>
          {item}
          <br />
        </span>
      ))}
    </h2>
  );
};

export { Message as default, Message };
