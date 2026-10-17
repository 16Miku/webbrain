import variables from 'config/variables';

import { Row, Content } from 'components/Layout/Settings';
import { Header } from 'components/Layout/Settings';
import offlineImages from 'features/background/offline_images.json';
import mueLicense from '../../../../LICENSE.mue-bsd-3-clause?raw';

function Credits() {
  const photographers = Object.keys(offlineImages);
  const { MUE_REPO_URL, MUE_VERSION, REPO_URL, WEBSITE_URL } = variables.constants;

  return (
    <>
      <Header title={variables.getMessage('wb.settings_credits')} />
      <Row>
        <Content
          title="WebBrain"
          subtitle="The WebBrain new tab is free software, licensed GPL-3.0-or-later, and makes no network requests of its own."
        />
      </Row>
      <Row>
        <Content
          title={`Based on Mue ${MUE_VERSION}`}
          subtitle={
            <>
              Derived from <a href={MUE_REPO_URL} target="_blank" rel="noreferrer">Mue</a> by The
              Mue Authors and David Ralph, used under the BSD-3-Clause license reproduced below.
              Mue is not affiliated with or endorsing WebBrain.
            </>
          }
        />
      </Row>
      <Row>
        <Content
          title={variables.getMessage('wb.settings_bundled_photos')}
          subtitle={`${photographers.join(', ')}. Offline images shipped with Mue (Unsplash, Pexels and Pixabay).`}
        />
      </Row>
      <Row>
        <Content
          title="Fonts and icons"
          subtitle="Inter, Lexend Deca and Montserrat (SIL Open Font License); Material Design icons via react-icons."
        />
      </Row>
      <Row final>
        <Content
          title="Mue license"
          subtitle={<pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{mueLicense}</pre>}
        />
      </Row>
      <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>
        <a href={WEBSITE_URL} target="_blank" rel="noreferrer">{WEBSITE_URL.replace('https://', '')}</a>
        {' · '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
      </p>
    </>
  );
}

export { Credits as default, Credits };
