import { useEffect, useState } from 'react';
import { wbT } from 'lib/wb-strings';
import { readRecentChats } from './recent';

import './taskbox.scss';

const HISTORY_PAGE = '../src/ui/history.html';

function RecentChats() {
  const [chats, setChats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    readRecentChats(4)
      .then((rows) => !cancelled && setChats(rows))
      .catch(() => !cancelled && setChats([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (chats === null) return null;

  return (
    <div className="recentChats">
      <div className="recentChatsHeader">
        <span>{wbT('wb.recent_title')}</span>
        <a href={HISTORY_PAGE}>{wbT('wb.recent_all')}</a>
      </div>
      {chats.length === 0 ? (
        <span className="recentChatsEmpty">{wbT('wb.recent_empty')}</span>
      ) : (
        <ul>
          {chats.map((chat) => (
            <li key={chat.id}>
              <a href={chat.url ? `${HISTORY_PAGE}?url=${encodeURIComponent(chat.url)}` : HISTORY_PAGE}>
                {chat.title || chat.url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RecentChats;
