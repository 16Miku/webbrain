import variables from 'config/variables';
import { memo, useState, useEffect } from 'react';
import { MdSource, MdOutlineAutoAwesome } from 'react-icons/md';
import EventBus from 'utils/eventbus';

import { Header } from 'components/Layout/Settings';
import { Dropdown } from 'components/Form/Settings';

import ColourSettings from './Colour';
import CustomSettings from './Custom';
import DisplaySettings from './sections/DisplaySettings';
import EffectsSettings from './sections/EffectsSettings';
import SourceSection from './sections/SourceSection';
import NavigationCard from './sections/NavigationCard';

import { getBackgroundOptionItems } from './optionTypes';

const BackgroundOptions = memo(({ currentSubSection, onSubSectionChange, sectionName }) => {
  const [backgroundType, setBackgroundType] = useState(
    localStorage.getItem('backgroundType') || 'api',
  );
  const [backgroundFilter, setBackgroundFilter] = useState(
    localStorage.getItem('backgroundFilter') || 'none',
  );

  // Auto-show source section for types without effects/display settings
  const shouldShowSourceByDefault = ['colour', 'random_colour', 'random_gradient'].includes(backgroundType);

  // Auto-navigate to source section when switching to colour/random types
  useEffect(() => {
    if (shouldShowSourceByDefault && currentSubSection !== 'source') {
      onSubSectionChange('source', sectionName);
    }
  }, [shouldShowSourceByDefault, currentSubSection, onSubSectionChange, sectionName]);

  const getBackgroundSettings = () => {
    switch (backgroundType) {
      case 'custom':
        return <CustomSettings />;
      case 'colour':
        return <ColourSettings />;
      default:
        return null;
    }
  };

  const usingImage =
    backgroundType !== 'colour' &&
    backgroundType !== 'random_colour' &&
    backgroundType !== 'random_gradient';

  const showEffects = backgroundType === 'api' || backgroundType === 'custom';

  const getHeader = () => {
    if (currentSubSection === 'effects') {
      return (
        <Header
          title={variables.getMessage('modals.main.settings.sections.background.title')}
          secondaryTitle={variables.getMessage(
            'modals.main.settings.sections.background.effects.title',
          )}
          goBack={() => onSubSectionChange(null, sectionName)}
        />
      );
    }

    if (currentSubSection === 'source') {
      return (
        <Header
          title={variables.getMessage('modals.main.settings.sections.background.title')}
          secondaryTitle={variables.getMessage(
            'modals.main.settings.sections.background.source.title',
          )}
          goBack={() => onSubSectionChange(null, sectionName)}
        />
      );
    }

    return (
      <Header
        title={variables.getMessage('modals.main.settings.sections.background.title')}
        setting="background"
        category="background"
        visibilityToggle={true}
      />
    );
  };

  return (
    <>
      {getHeader()}

      {!currentSubSection && (
        <>
          <NavigationCard
            icon={MdSource}
            title={variables.getMessage('modals.main.settings.sections.background.source.title')}
            subtitle={variables.getMessage(
              'modals.main.settings.sections.background.source.subtitle',
            )}
            onClick={() => onSubSectionChange('source', sectionName)}
            action={
              <Dropdown
                label={variables.getMessage('modals.main.settings.sections.background.type.title')}
                name="backgroundType"
                onChange={(value) => {
                  setBackgroundType(value);
                  // Automatically refresh background when switching to custom images
                  if (value === 'custom') {
                    EventBus.emit('refresh', 'background');
                  }
                }}
                category="background"
                items={getBackgroundOptionItems()}
              />
            }
          />

          {showEffects && (
            <NavigationCard
              icon={MdOutlineAutoAwesome}
              title={variables.getMessage(
                'modals.main.settings.sections.background.effects.title',
              )}
              subtitle={variables.getMessage(
                'modals.main.settings.sections.background.effects.subtitle',
              )}
              onClick={() => onSubSectionChange('effects', sectionName)}
            />
          )}
        </>
      )}

      {!currentSubSection && showEffects && <DisplaySettings usingImage={usingImage} />}

      {currentSubSection === 'source' && (
        <>
          <SourceSection backgroundType={backgroundType} onTypeChange={setBackgroundType} />
          {getBackgroundSettings()}
        </>
      )}

      {showEffects && currentSubSection === 'effects' && (
        <EffectsSettings
          backgroundFilter={backgroundFilter}
          onFilterChange={(value) => setBackgroundFilter(value)}
        />
      )}
    </>
  );
});

BackgroundOptions.displayName = 'BackgroundOptions';

export { BackgroundOptions as default, BackgroundOptions };
