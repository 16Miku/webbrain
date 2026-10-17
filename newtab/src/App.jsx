import { useEffect, useState } from 'react';
import { ToastContainer } from 'react-toastify';
import Background from 'features/background/Background';
import Widgets from 'features/misc/views/Widgets';
import Modals from 'features/misc/modals/Modals';
import { loadSettings, moveSettings } from 'utils/settings';
import EventBus from 'utils/eventbus';
import variables from 'config/variables';
import { TranslationProvider } from 'contexts/TranslationContext';
import { rawStorage } from 'lib/storage-namespace';

const useAppSetup = (onDefaultsApplied) => {
  useEffect(() => {
    // First run (or a wiped store): write the defaults, then reload once so
    // every widget reads them. Namespaced storage keeps this from touching
    // WebBrain's own keys.
    if (!localStorage.getItem('firstRun')) {
      moveSettings();
      if (rawStorage) {
        window.location.reload();
      } else {
        // Storage is only in memory (blocked site data / some private windows), so a
        // reload would start from empty again, forever. Re-mount with the defaults instead.
        onDefaultsApplied?.();
      }
    }

    loadSettings();

    const refreshHandler = (data) => {
      if (data === 'other') {
        loadSettings(true);
      }
    };

    // Import while storage is only in memory: a reload would discard it, so rebuild instead.
    const importedHandler = () => onDefaultsApplied?.();

    EventBus.on('refresh', refreshHandler);
    EventBus.on('settingsimported', importedHandler);

    variables.stats.tabLoad();

    return () => {
      EventBus.off('refresh', refreshHandler);
      EventBus.off('settingsimported', importedHandler);
    };
  }, []);
};

const App = () => {
  const [toastDisplayTime, setToastDisplayTime] = useState(2500);
  const [showBackground, setShowBackground] = useState(false);

  useEffect(() => {
    const storedToastDisplayTime = localStorage.getItem('toastDisplayTime');
    const storedBackground = localStorage.getItem('background');

    if (storedToastDisplayTime) {
      setToastDisplayTime(parseInt(storedToastDisplayTime, 10));
    }

    if (storedBackground === 'true') {
      setShowBackground(true);
    }

    // Hide/Show in the background settings: mount or unmount the background without a reload.
    const handleRefresh = (data) => {
      if (data === 'background') {
        setShowBackground(localStorage.getItem('background') === 'true');
      }
    };
    EventBus.on('refresh', handleRefresh);
    return () => EventBus.off('refresh', handleRefresh);
  }, []);

  // Bumped once when defaults were written without a reload; remounts the widgets so they read them.
  const [setupKey, setSetupKey] = useState(0);
  useAppSetup(() => {
    setSetupKey((key) => key + 1);
    setShowBackground(localStorage.getItem('background') === 'true');
  });

  const languagecode = localStorage.getItem('language') || 'en_GB';

  return (
    <TranslationProvider initialLanguage={languagecode}>
      {showBackground && <Background key={setupKey} />}
      <ToastContainer
        position="top-center"
        autoClose={toastDisplayTime}
        newestOnTop={true}
        closeOnClick
        pauseOnFocusLoss
      />
      <div id="center" key={setupKey}>
        <Widgets />
        <Modals />
      </div>
    </TranslationProvider>
  );
};

export default App;
