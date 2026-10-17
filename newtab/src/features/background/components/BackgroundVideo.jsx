import { memo, useEffect, useState } from 'react';
import EventBus from 'utils/eventbus';

const readFlags = () => ({
  muted: localStorage.getItem('backgroundVideoMute') === 'true',
  loop: localStorage.getItem('backgroundVideoLoop') === 'true',
});

/**
 * BackgroundVideo component for rendering video backgrounds
 */
function BackgroundVideo({ url, filterStyle }) {
  const [{ muted, loop }, setFlags] = useState(readFlags);

  // The Loop / Mute checkboxes only write storage and emit this refresh, so pick the
  // values up again here instead of keeping the ones from first render.
  useEffect(() => {
    const handleRefresh = (data) => {
      if (data === 'backgroundvideo') setFlags(readFlags());
    };
    EventBus.on('refresh', handleRefresh);
    return () => EventBus.off('refresh', handleRefresh);
  }, []);

  return (
    <video
      // Changing a child <source> does not restart loading, so a new url needs a new element.
      key={url}
      autoPlay
      muted={muted}
      loop={loop}
      style={filterStyle}
      id="backgroundVideo"
    >
      <source src={url} />
    </video>
  );
}

export default memo(BackgroundVideo);
