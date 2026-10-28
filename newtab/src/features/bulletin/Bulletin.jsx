import { useEffect, useState } from 'react';
import { MdClose } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import CompanionPromo from 'features/companion/CompanionPromo';
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

// Rendered under the task box. While webbrain.one publishes nothing (or the file cannot be
// read), the slot invites people to install WebBrain Companion instead, which decides for
// itself whether to show (companion-promo.js). A bulletin dismissed on this page leaves the
// slot empty here rather than putting the invitation in its place.
function Bulletin() {
  const [bulletin, setBulletin] = useState(null);
  const [checked, setChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    // After first paint: the page never waits for webbrain.one.
    loadOnce().then((result) => {
      if (!alive) return;
      setBulletin(result && result.hash !== dismissedHere ? result : null);
      setChecked(true);
    });
    return () => { alive = false; };
  }, []);

  if (!bulletin) return checked && !dismissedHere ? <CompanionPromo /> : null;

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
