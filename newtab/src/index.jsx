// Must stay first: namespaces localStorage so Mue's code can't touch the
// WebBrain keys that share this extension origin.
import 'lib/storage-namespace';

import { createRoot } from 'react-dom/client';

import App from './App';
import ErrorBoundary from './ErrorBoundary';
import variables from './config/variables';

import './scss/index.scss';
// the toast css is based on default so we need to import it
import 'react-toastify/dist/ReactToastify.css';

import { initTranslations } from 'lib/translations';
import { resolveMueLanguage } from 'lib/locale';
import { isWbKey, wbT } from 'lib/wb-strings';

const languagecode = resolveMueLanguage();
localStorage.setItem('language', languagecode);
variables.language = initTranslations(languagecode);
variables.languagecode = languagecode;
document.documentElement.lang = languagecode.replace('_', '-');

variables.getMessage = (text, optional) =>
  isWbKey(text)
    ? wbT(text)
    : variables.language.getMessage(variables.languagecode, text, optional || {});

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
