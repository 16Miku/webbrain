import variables from 'config/variables';

export function getBackgroundOptionItems() {
  return [
    {
      value: 'api',
      text: variables.getMessage('wb.settings_bundled_photos'),
    },
    {
      value: 'custom',
      text: variables.getMessage('modals.main.settings.sections.background.type.custom_image'),
    },
    {
      value: 'colour',
      text: variables.getMessage('modals.main.settings.sections.background.type.custom_colour'),
    },
    {
      value: 'random_colour',
      text: variables.getMessage('modals.main.settings.sections.background.type.random_colour'),
    },
    {
      value: 'random_gradient',
      text: variables.getMessage('modals.main.settings.sections.background.type.random_gradient'),
    },
  ];
}
