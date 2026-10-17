import variables from 'config/variables';
import { memo, useState, useCallback } from 'react';
import { useT } from 'contexts';

import { MdCropFree } from 'react-icons/md';

import { Tooltip } from 'components/Elements';

const Maximise = memo(({ fontSize }) => {
  const t = useT();
  const [hidden, setHidden] = useState(false);

  const setAttribute = useCallback((blur, brightness, filter) => {
    // don't attempt to modify the background if it isn't an image
    const backgroundType = localStorage.getItem('backgroundType');
    if (
      backgroundType === 'colour' ||
      backgroundType === 'random_colour' ||
      backgroundType === 'random_gradient'
    ) {
      return;
    }

    // A custom video background has no #backgroundImage; it takes the same filter on the <video>.
    const video = document.getElementById('backgroundVideo');
    const element = document.getElementById('backgroundImage');
    if (!video && !element) return;

    let backgroundFilter;
    if (filter === true) {
      const filterData = localStorage.getItem('backgroundFilter');
      if (filterData !== 'none') {
        backgroundFilter = filterData;
      }
    }

    const filterValue = `blur(${blur}px) brightness(${brightness}%) ${
      backgroundFilter
        ? backgroundFilter + '(' + localStorage.getItem('backgroundFilterAmount') + '%)'
        : ''
    }`;

    if (video) {
      video.style.webkitFilter = filterValue;
      return;
    }

    element.setAttribute(
      'style',
      `background-image: url(${element.style.backgroundImage
        .replace('url("', '')
        .replace('")', '')}); -webkit-filter: ${filterValue};`,
    );
  }, []);

  const maximise = useCallback(() => {
    // hide widgets
    const widgets = document.getElementById('widgets');

    if (!hidden) {
      if (widgets) widgets.style.display = 'none';
      setHidden(true);
      setAttribute(0, 100);
      variables.stats.postEvent('feature', 'Background maximise');
    } else {
      if (widgets) widgets.style.display = 'flex';
      setHidden(false);
      setAttribute(localStorage.getItem('blur'), localStorage.getItem('brightness'), true);
      variables.stats.postEvent('feature', 'Background unmaximise');
    }
  }, [hidden, setAttribute]);

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
