import { Suspense, lazy, useState, memo, useEffect } from 'react';

import './scss/index.scss';
import ModalLoader from './components/ModalLoader';
import ModalTopBar from './components/ModalTopBar';
import { TAB_TYPES } from './constants/tabConfig';
import { updateHash, parseDeepLink } from 'utils/deepLinking';

const Settings = lazy(() => import('../../../features/misc/views/Settings'));

function MainModal({ modalClose, deepLinkData }) {
  const currentTab = TAB_TYPES.SETTINGS;
  const [currentSection, setCurrentSection] = useState('');
  const [currentSectionName, setCurrentSectionName] = useState('');
  const [currentSubSection, setCurrentSubSection] = useState(deepLinkData?.subSection || null);
  const [navigationTrigger, setNavigationTrigger] = useState(null);

  // Opening via a hash (e.g. #settings/background) jumps to that section.
  useEffect(() => {
    if (deepLinkData?.section) {
      setNavigationTrigger({
        type: 'settings-section',
        data: deepLinkData.section,
        timestamp: Date.now(),
      });
      if (deepLinkData.subSection) {
        setCurrentSubSection(deepLinkData.subSection);
      }
    }
  }, [deepLinkData]);

  // Clear the hash when the modal closes
  useEffect(() => {
    return () => {
      if (window.location.hash) {
        window.history.replaceState(null, null, window.location.pathname);
      }
    };
  }, []);

  // Browser back/forward moves between settings sections
  useEffect(() => {
    const handlePopState = () => {
      const linkData = window.location.hash ? parseDeepLink(window.location.hash) : null;
      if (linkData?.section) {
        setNavigationTrigger({
          type: 'settings-section',
          data: linkData.section,
          timestamp: Date.now(),
        });
        setCurrentSubSection(linkData.subSection || null);
      } else if (!window.location.hash) {
        // Back left the settings route (to the bare new tab URL): the modal has to go too.
        modalClose?.();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [modalClose]);

  const handleSectionChange = (section, sectionName) => {
    setCurrentSection(section);
    setCurrentSectionName(sectionName);
    // Clear sub-section when changing sections
    setCurrentSubSection(null);
    if (sectionName) {
      updateHash(`#${currentTab}/${sectionName}`, false);
    }
  };

  const handleSubSectionChange = (subSection, sectionName) => {
    setCurrentSubSection(subSection);
    if (sectionName) {
      updateHash(subSection ? `#${currentTab}/${sectionName}/${subSection}` : `#${currentTab}/${sectionName}`);
    }
  };

  return (
    <div className="frame">
      <ModalTopBar
        currentTab={currentTab}
        currentSection={currentSection}
        currentSectionName={currentSectionName}
        currentSubSection={currentSubSection}
        onSubSectionChange={handleSubSectionChange}
        onClose={modalClose}
        onBack={() => window.history.back()}
        onForward={() => window.history.forward()}
        canGoBack
        canGoForward
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <Suspense fallback={<ModalLoader currentTab={currentTab} />}>
          <Settings
            key={currentTab}
            currentTab={currentTab}
            changeTab={() => {}}
            deepLinkData={deepLinkData}
            onSectionChange={handleSectionChange}
            onSubSectionChange={handleSubSectionChange}
            currentSubSection={currentSubSection}
            navigationTrigger={navigationTrigger}
          />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(MainModal);
