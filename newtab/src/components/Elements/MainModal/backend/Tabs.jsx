import { useState, useEffect, useRef } from 'react';
import { useT } from 'contexts/TranslationContext';
import variables from 'config/variables';
import EventBus from 'utils/eventbus';
import Tab from './Tab';
import ReminderInfo from '../components/ReminderInfo';
import ErrorBoundary from '../../../../features/misc/modals/ErrorBoundary';
import { TAB_TYPES } from '../constants/tabConfig';

const Tabs = ({
  children,
  navbar = false,
  currentTab: activeTab,
  onSectionChange,
  resetToFirst,
  deepLinkData,
  navigationTrigger,
  sections,
}) => {
  const t = useT();

  // Find initial section from deep link if available
  const getInitialSection = () => {
    if (deepLinkData?.section && sections) {
      const section = sections.find((s) => s.name === deepLinkData.section);
      if (section) {
        return {
          label: t(section.label),
          name: section.name,
        };
      }
    }
    return {
      label: children[0]?.props.label,
      name: children[0]?.props.name,
    };
  };

  const initial = getInitialSection();
  const [currentTab, setCurrentTab] = useState(initial.label);
  const [currentName, setCurrentName] = useState(initial.name);
  const [showReminder, setShowReminder] = useState(localStorage.getItem('showReminder') === 'true');
  const contentRef = useRef(null);
  const handledTriggerRef = useRef(null);

  const handleTabClick = (tab, name) => {
    if (name !== currentName) {
      variables.stats.postEvent('tab', `Opened ${name}`);
    }

    setCurrentTab(tab);
    setCurrentName(name);

    // Scroll content to top when changing tabs
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }

    // Notify parent of section change with both label and name
    if (onSectionChange) {
      onSectionChange(tab, name);
    }
  };

  // Notify parent of initial section on mount
  useEffect(() => {
    if (onSectionChange && currentTab) {
      // Not a user navigation: opening at #settings/<section>/<sub> must keep that route.
      onSectionChange(currentTab, currentName, { fromHistory: true });
    }
  }, []);

  // Update labels when language changes
  useEffect(() => {
    if (sections && currentName) {
      const section = sections.find((s) => s.name === currentName);
      if (section) {
        const newLabel = t(section.label);
        setCurrentTab(newLabel);
      }
    }
  }, [t, sections, currentName]);

  // Handle navigation trigger for settings sections (popstate)
  useEffect(() => {
    // t and sections change with the language; a trigger already acted on must not run again
    // (it would snap the modal back to that section).
    if (!navigationTrigger || handledTriggerRef.current === navigationTrigger) return;
    if (navigationTrigger?.type === 'settings-default') {
      handledTriggerRef.current = navigationTrigger;
      const first = children[0]?.props;
      if (first) {
        setCurrentTab(first.label);
        setCurrentName(first.name);
        if (contentRef.current) {
          contentRef.current.scrollTop = 0;
        }
        onSectionChange?.(first.label, first.name, { fromHistory: true });
      }
      return;
    }
    if (navigationTrigger?.type === 'settings-section' && sections) {
      const section = sections.find((s) => s.name === navigationTrigger.data);
      if (section) {
        handledTriggerRef.current = navigationTrigger;
        const label = t(section.label);
        setCurrentTab(label);
        setCurrentName(section.name);
        // Scroll content to top when navigating via browser history
        if (contentRef.current) {
          contentRef.current.scrollTop = 0;
        }
        // Keep the breadcrumb in step; the route is already right, so don't rewrite it.
        onSectionChange?.(label, section.name, { fromHistory: true });
      }
    }
  }, [navigationTrigger, sections, t]);

  // Reset to first tab when requested
  useEffect(() => {
    if (resetToFirst) {
      setCurrentTab(children[0]?.props.label);
      setCurrentName(children[0]?.props.name);
      // Scroll content to top when resetting to first tab
      if (contentRef.current) {
        contentRef.current.scrollTop = 0;
      }
      if (onSectionChange) {
        onSectionChange(children[0]?.props.label, children[0]?.props.name);
      }
    }
  }, [resetToFirst]);

  // showReloadReminder() asks for the notice through this event.
  useEffect(() => {
    const handleReminder = () => setShowReminder(true);
    EventBus.on('reminder', handleReminder);
    return () => EventBus.off('reminder', handleReminder);
  }, []);

  const handleHideReminder = () => {
    localStorage.setItem('showReminder', 'false');
    setShowReminder(false);
  };

  // Show sidebar for Settings and Discover tabs
  const showSidebar = activeTab === TAB_TYPES.SETTINGS || activeTab === TAB_TYPES.DISCOVER;

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
      {showSidebar ? (
        <div className="modalSidebar">
          {children.map((tab, index) => (
            <Tab
              key={index}
              currentTab={currentTab}
              label={tab.props.label}
              onClick={(nextTab) => handleTabClick(nextTab, tab.props.name)}
              navbarTab={navbar}
            />
          ))}
          <ReminderInfo isVisible={showReminder} onHide={handleHideReminder} />
        </div>
      ) : null}
      <div className="modalTabContent" ref={contentRef}>
        {children.map((tab, index) => {
          if (tab.props.label !== currentTab) {
            return null;
          }

          return (
            <ErrorBoundary key={`error-boundary-${index}`}>{tab.props.children}</ErrorBoundary>
          );
        })}
      </div>
    </div>
  );
};

export default Tabs;
