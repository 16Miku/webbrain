import { useEffect, useState } from 'react';
import { ToastContainer } from 'react-toastify';
import Background from 'features/background/Background';
import Widgets from 'features/misc/views/Widgets';
import Modals from 'features/misc/modals/Modals';
import { loadSettings, moveSettings } from 'utils/settings';
import EventBus from 'utils/eventbus';
import variables from 'config/variables';
import { TranslationProvider } from 'contexts/TranslationContext';

const useAppSetup = () => {
  useEffect(() => {
    // First run (or a wiped store): write the defaults, then reload once so
    // every widget reads them. Namespaced storage keeps this from touching
    // WebBrain's own keys.
    if (!localStorage.getItem('firstRun')) {
      moveSettings();
      window.location.reload();
    }

    loadSettings();

    const refreshHandler = (data) => {
      if (data === 'other') {
        loadSettings(true);
      }
    };

    EventBus.on('refresh', refreshHandler);

    variables.stats.tabLoad();

    return () => {
      EventBus.off('refresh', refreshHandler);
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
  }, []);

  useAppSetup();

  const languagecode = localStorage.getItem('language') || 'en_GB';

  return (
    <TranslationProvider initialLanguage={languagecode}>
      {showBackground && <Background />}
      <ToastContainer
        position="top-center"
        autoClose={toastDisplayTime}
        newestOnTop={true}
        closeOnClick
        pauseOnFocusLoss
      />
      <div id="center">
        <Widgets />
        <Modals />
      </div>
    </TranslationProvider>
  );
};

export default App;
