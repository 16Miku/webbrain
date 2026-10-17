import { useT } from 'contexts/TranslationContext';
import { MdClose, MdChevronRight, MdArrowBack, MdArrowForward } from 'react-icons/md';
import { Tooltip } from 'components/Elements';
import { NAVBAR_BUTTONS } from '../constants/tabConfig';
import wbIcon from 'assets/icons/webbrain.png';

function ModalTopBar({
  currentTab,
  currentSection,
  currentSectionName,
  currentSubSection,
  onSubSectionChange,
  onClose,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
}) {
  const t = useT();

  // Get the current tab label
  const currentTabButton = NAVBAR_BUTTONS.find(({ tab }) => tab === currentTab);
  const currentTabLabel = currentTabButton ? t(currentTabButton.messageKey) : '';

  // Utility function to get translated sub-section label
  const getSubSectionLabel = (subSection, sectionName) => {
    if (!subSection || !sectionName) return subSection;

    // Use the same translation pattern as the section components
    const translationKey = `modals.main.settings.sections.${sectionName}.${subSection}.title`;
    const translated = t(translationKey);

    // If translation key is returned as-is or empty, it means translation doesn't exist
    // Fall back to capitalized sub-section name
    if (!translated || translated === translationKey) {
      return subSection.charAt(0).toUpperCase() + subSection.slice(1);
    }

    return translated;
  };

  // Determine breadcrumb path with click handlers
  const breadcrumbPath = [];

  if (currentTabLabel) {
    breadcrumbPath.push({
      label: currentTabLabel,
      onClick: null,
    });

    if (currentSection) {
      // Show: Tab > Section or Tab > Section > Sub-Section
      breadcrumbPath.push({
        label: currentSection,
        onClick: currentSubSection ? () => onSubSectionChange(null) : null, // Clickable if sub-section is active
      });

      // Add sub-section if present
      if (currentSubSection) {
        breadcrumbPath.push({
          label: getSubSectionLabel(currentSubSection, currentSectionName),
          onClick: null, // Current sub-section - not clickable
        });
      }
    }
  }

  return (
    <div className="modalTopBar">
      <div className="topBarLeft">
        <div className="navigationButtons">
          <Tooltip title="Back" key="backTooltip">
            <button
              className="navButton"
              onClick={onBack}
              disabled={!canGoBack}
              aria-label="Navigate back"
            >
              <MdArrowBack />
            </button>
          </Tooltip>
          <Tooltip title="Forward" key="forwardTooltip">
            <button
              className="navButton"
              onClick={onForward}
              disabled={!canGoForward}
              aria-label="Navigate forward"
            >
              <MdArrowForward />
            </button>
          </Tooltip>
        </div>
        <img
          src={wbIcon}
          alt="WebBrain"
          className="topBarLogo"
          draggable={false}
        />
        {breadcrumbPath.length > 0 && (
          <nav className="breadcrumbs" aria-label="Breadcrumb navigation">
            {breadcrumbPath.map((item, index) => {
              const isLast = index === breadcrumbPath.length - 1;
              const isClickable = item.onClick !== null;

              return (
                <span key={index} className="breadcrumb-segment">
                  {isClickable ? (
                    <span
                      className={`breadcrumb-item breadcrumb-clickable`}
                      onClick={item.onClick}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          item.onClick();
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Navigate to ${item.label}`}
                    >
                      {item.label}
                    </span>
                  ) : (
                    <span
                      className={`breadcrumb-item ${isLast ? 'breadcrumb-current' : ''}`}
                      aria-current={isLast ? 'page' : undefined}
                    >
                      {item.label}
                    </span>
                  )}
                  {!isLast && <MdChevronRight className="breadcrumb-separator" aria-hidden="true" />}
                </span>
              );
            })}
          </nav>
        )}
      </div>
      <div className="topBarRight">
        <Tooltip title={t('modals.welcome.buttons.close')} key="closeTooltip">
          <span className="closeModal" onClick={onClose}>
            <MdClose />
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

export default ModalTopBar;
