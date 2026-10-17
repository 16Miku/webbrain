import { useState, useEffect, Fragment, useMemo } from 'react';

import Clock from '../../time/Clock';
import Greeting from '../../greeting/Greeting';
import TaskBox from '../../agent/TaskBox';
import RecentChats from '../../agent/RecentChats';
import QuickLinks from '../../quicklinks/QuickLinks';
import Date from '../../time/Date';
import Message from '../../message/Message';
import { WidgetsLayout } from 'components/Layout';

import EventBus from 'utils/eventbus';

const readOrder = () => {
  try {
    const order = JSON.parse(localStorage.getItem('order'));
    return Array.isArray(order) ? order : [];
  } catch {
    return [];
  }
};

const enabled = (key) => localStorage.getItem(key) === 'true';

const Widgets = () => {
  const [order, setOrder] = useState(readOrder);

  // widgets we can re-order
  const widgets = useMemo(
    () => ({
      time: enabled('time') && <Clock />,
      greeting: enabled('greeting') && <Greeting />,
      date: enabled('date') && <Date />,
      quicklinks: enabled('quicklinksenabled') ? <QuickLinks /> : null,
      message: enabled('message') && <Message />,
    }),
    [order], // Re-create widgets when order changes
  );

  useEffect(() => {
    const handleRefresh = (data) => {
      if (data === 'widgets') {
        setOrder(readOrder());
      }
    };

    EventBus.on('refresh', handleRefresh);
    return () => {
      EventBus.off('refresh', handleRefresh);
    };
  }, []);

  return (
    <WidgetsLayout>
      {order.map((element, key) => (
        <Fragment key={key}>{widgets[element]}</Fragment>
      ))}
      {enabled('taskBox') && <TaskBox />}
      {enabled('recentChats') && <RecentChats />}
    </WidgetsLayout>
  );
};

export { Widgets as default, Widgets };
