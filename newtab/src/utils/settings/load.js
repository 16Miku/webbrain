import variables from 'config/variables';

/**
 * It loads the settings from localStorage and applies them to the page.
 * @param hotreload - boolean
 */
export function loadSettings(hotreload) {
  switch (localStorage.getItem('theme')) {
    case 'dark':
      document.body.classList.add('dark');
      document.body.classList.remove('light');
      break;
    case 'auto':
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
        document.body.classList.add('light');
      }
      break;
    default:
      document.body.classList.add('light');
      document.body.classList.remove('dark');
  }

  document.title = localStorage.getItem('tabName') || variables.getMessage('tabname');

  if (hotreload === true) {
    // remove old custom stuff and add new
    const custom = ['customcss', 'customfont'];
    custom.forEach((element) => {
      try {
        document.head.removeChild(document.getElementById(element));
      } catch (e) {
        // Disregard exception if custom stuff doesn't exist
      }
    });
  }

  if (localStorage.getItem('animations') === 'false') {
    document.body.classList.add('no-animations');
  } else {
    document.body.classList.remove('no-animations');
  }

  // technically, this is text SHADOW, and not BORDER
  // however it's a mess and we'll just leave it at this for now
  const textBorder = localStorage.getItem('textBorder');
  // enable/disable old text border from before redesign
  if (textBorder === 'true') {
    const elements = ['greeting', 'clock', 'date'];
    elements.forEach((element) => {
      try {
        document.querySelector('.' + element).classList.add('textBorder');
      } catch (e) {
        // Disregard exception
      }
    });
  } else {
    const elements = ['greeting', 'clock', 'date'];
    elements.forEach((element) => {
      try {
        document.querySelector('.' + element).classList.remove('textBorder');
      } catch (e) {
        // Disregard exception
      }
    });
  }

  // remove actual default shadow
  if (textBorder === 'none') {
    document.getElementById('center').classList.add('no-textBorder');
  } else {
    document.getElementById('center').classList.remove('no-textBorder');
  }

  const css = localStorage.getItem('customcss');
  if (css) {
    // Text, never markup: a literal "</style>" inside the CSS (valid in a CSS
    // string, or planted by an imported backup) must not end the element.
    const customStyle = document.createElement('style');
    customStyle.id = 'customcss';
    customStyle.textContent = css;
    document.head.appendChild(customStyle);
  }

  const font = localStorage.getItem('font');
  if (font) {
    // Only fonts already installed on the system: the new tab never loads
    // remote fonts (upstream's "Google font" option has been removed).
    const fontStyle = document.createElement('style');
    fontStyle.id = 'customfont';
    fontStyle.textContent = `
      * {
        font-family: '${font}', 'Lexend Deca', 'Inter', sans-serif !important;
        font-weight: ${localStorage.getItem('fontweight')};
        font-style: ${localStorage.getItem('fontstyle')};
      }
    `;
    document.head.appendChild(fontStyle);
  }

  // If the extension got updated and the new app links default settings
  // were not set, set them
  if (localStorage.getItem('applinks') === null) {
    localStorage.setItem('applinks', JSON.stringify([]));
  }
  if (localStorage.getItem('appsEnabled') === null) {
    localStorage.setItem('showWelcome', false);
  }

  // everything below this shouldn't run on a hot reload event
  if (hotreload === true) {
    return;
  }

}
