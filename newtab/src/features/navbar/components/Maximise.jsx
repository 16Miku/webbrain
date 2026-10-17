import variables from 'config/variables';
import { memo, useState, useCallback } from 'react';
import { useT } from 'contexts';

import { MdCropFree } from 'react-icons/md';

import { Tooltip } from 'components/Elements';
import {
  getBackgroundFilterStyle,
  getBackgroundOverlayStyle,
} from 'features/background/api/backgroundFilters';

const Maximise = memo(({ fontSize }) => {
  const t = useT();
  const [hidden, setHidden] = useState(false);

  // Maximise shows the background without its effects; restoring puts them back.
  // Image effects live on #backgroundFilterOverlay (see useBackgroundEvents) and a video
  // takes the filter on the <video> itself, so those are the elements to clear / restore.
  const setEffects = useCallback((on) => {
    const video = document.getElementById('backgroundVideo');
    if (video) {
      video.style.webkitFilter = on ? getBackgroundFilterStyle() : 'blur(0px) brightness(100%)';
    }

    const overlay = document.getElementById('backgroundFilterOverlay');
    if (overlay) {
      const style = on
        ? getBackgroundOverlayStyle()
        : { backdropFilter: '', WebkitBackdropFilter: '', backgroundColor: '' };
      overlay.style.backdropFilter = style.backdropFilter;
      overlay.style.webkitBackdropFilter = style.WebkitBackdropFilter;
      overlay.style.backgroundColor = style.backgroundColor;
    }
  }, []);

  const maximise = useCallback(() => {
    // hide widgets
    const widgets = document.getElementById('widgets');

    if (!hidden) {
      if (widgets) widgets.style.display = 'none';
      setHidden(true);
      setEffects(false);
      variables.stats.postEvent('feature', 'Background maximise');
    } else {
      if (widgets) widgets.style.display = 'flex';
      setHidden(false);
      setEffects(true);
      variables.stats.postEvent('feature', 'Background unmaximise');
    }
  }, [hidden, setEffects]);

  return (
    <Tooltip
      title={t('modals.main.settings.sections.background.buttons.view')}
    >
      <button
        className="navbarButton"
        style={{ fontSize }}
        onClick={maximise}
        aria-label={t('modals.main.settings.sections.background.buttons.view')}
      >
        <MdCropFree className="topicons" />
      </button>
    </Tooltip>
  );
});

Maximise.displayName = 'Maximise';

export { Maximise as default, Maximise };
