import { memo, useMemo } from 'react';
import { useT } from 'contexts/TranslationContext';

import Tabs from 'components/Elements/MainModal/backend/Tabs';

import { NavbarOptions } from 'features/navbar';
import { GreetingOptions } from 'features/greeting';
import { TimeOptions, DateOptions } from 'features/time';
import { QuickLinksOptions } from 'features/quicklinks';
import { MessageOptions } from 'features/message';
import { BackgroundOptions } from 'features/background';
import { TaskBoxOptions } from 'features/agent/TaskBoxOptions';
import { AdvancedOptions, AppearanceOptions, Credits, Overview } from '../sections';

const sections = [
  { label: 'modals.main.marketplace.product.overview', name: 'order', component: Overview },
  {
    label: 'modals.main.settings.sections.appearance.navbar.title',
    name: 'navbar',
    component: NavbarOptions,
  },
  {
    label: 'modals.main.settings.sections.greeting.title',
    name: 'greeting',
    component: GreetingOptions,
  },
  { label: 'modals.main.settings.sections.time.title', name: 'time', component: TimeOptions },
  {
    label: 'modals.main.settings.sections.quicklinks.title',
    name: 'quicklinks',
    component: QuickLinksOptions,
  },
  { label: 'modals.main.settings.sections.date.title', name: 'date', component: DateOptions },
  {
    label: 'modals.main.settings.sections.message.title',
    name: 'message',
    component: MessageOptions,
  },
  {
    label: 'modals.main.settings.sections.background.title',
    name: 'background',
    component: BackgroundOptions,
  },
  { label: 'wb.settings_taskbox', name: 'taskbox', component: TaskBoxOptions },
  {
    label: 'modals.main.settings.sections.appearance.title',
    name: 'appearance',
    component: AppearanceOptions,
  },
  {
    label: 'modals.main.settings.sections.advanced.title',
    name: 'advanced',
    component: AdvancedOptions,
  },
  { label: 'wb.settings_credits', name: 'credits', component: Credits },
];

function Settings(props) {
  const t = useT();

  // Recalculate section labels when language changes
  const translatedSections = useMemo(() =>
    sections.map(section => ({
      ...section,
      translatedLabel: t(section.label)
    })),
    [t]
  );

  return (
    <Tabs
      changeTab={(type) => props.changeTab(type)}
      current="settings"
      currentTab={props.currentTab}
      onSectionChange={props.onSectionChange}
      onSubSectionChange={props.onSubSectionChange}
      currentSubSection={props.currentSubSection}
      deepLinkData={props.deepLinkData}
      navigationTrigger={props.navigationTrigger}
      sections={sections}
    >
      {translatedSections.map(({ label, name, component: Component, translatedLabel }) => (
        <div key={name} label={translatedLabel} name={name}>
          <Component
            currentSubSection={props.currentSubSection}
            onSubSectionChange={props.onSubSectionChange}
            sectionName={name}
          />
        </div>
      ))}
    </Tabs>
  );
}

export default memo(Settings);
