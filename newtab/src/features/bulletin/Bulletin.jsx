import { useEffect, useState } from 'react';
import { MdClose } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import { bulletinDocument, dismissBulletin, loadBulletin } from './bulletin';

import './bulletin.scss';

// One check per page, even if the widget tree mounts this more than once.
let pending = null;
// Dismissed on this page: a remount must not bring it back before storage is read again.
let dismissedHere = null;
const loadOnce = () => {
  pending ??= loadBulletin();
  return pending;
};

// Rendered under the task box. Until webbrain.one publishes something it renders nothing,
// so the page looks and lays out exactly as it did without it.
function Bulletin() {
  const [bulletin, setBulletin] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    // After first paint: the page never waits for webbrain.one.
    loadOnce().then((result) => {
      if (alive) setBulletin(result && result.hash !== dismissedHere ? result : null);
    });
    return () => { alive = false; };
  }, []);

  if (!bulletin) return null;

  return (
    <aside className={loaded ? 'wbBulletin loaded' : 'wbBulletin'} aria-label={wbT('wb.bulletin_label')}>
      <iframe
        className="wbBulletinFrame"
        title={wbT('wb.bulletin_label')}
        srcDoc={bulletinDocument(bulletin.markup, new URL(bulletin.url))}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        loading="eager"
        onLoad={() => setLoaded(true)}
      />
      <button
        type="button"
        className="wbBulletinDismiss"
        title={wbT('wb.bulletin_dismiss')}
        aria-label={wbT('wb.bulletin_dismiss')}
        onClick={() => {
          dismissedHere = bulletin.hash;
          dismissBulletin(bulletin.hash);
          setBulletin(null);
        }}
      >
        <MdClose />
      </button>
    </aside>
  );
}

export default Bulletin;
