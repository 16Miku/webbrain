import { memo } from 'react';
import { useT } from 'contexts';

/**
 * Credit line for the bundled photos. (Upstream also offered favourite, share,
 * exclude and map controls backed by Mue's API; none of that is shipped.)
 */
function PhotoInformation({ info }) {
  const t = useT();

  if (info.hidden === true || !info.credit || localStorage.getItem('photoInformation') === 'false') {
    return null;
  }

  return (
    <div
      className="photoInformation"
      style={{
        position: 'absolute',
        left: '1rem',
        bottom: '1rem',
        padding: '4px 10px',
        borderRadius: '10px',
        fontSize: '0.8rem',
        color: '#fff',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      <span id="credit">
        {t('widgets.background.credit')} {info.credit}
      </span>
    </div>
  );
}

export default memo(PhotoInformation);
