import { memo } from 'react';
import { toast } from 'react-toastify';
import variables from 'config/variables';
import { MdClose, MdRestartAlt } from 'react-icons/md';
import { setDefaultSettings } from 'utils/settings';
import { clearAllBackgrounds } from 'utils/customBackgroundDB';
import { Tooltip, Button } from 'components/Elements';

function ResetModal({ modalClose }) {
  const reset = async () => {
    variables.stats.postEvent('setting', 'Reset');
    // Uploaded backgrounds live in IndexedDB, not localStorage; the reset promises to
    // delete everything, so they go too (and stop taking up space).
    try {
      await clearAllBackgrounds();
    } catch (error) {
      // Resetting the settings while the uploads stay behind would break the "delete
      // everything" promise (they would reappear with the custom source), so stop here.
      console.error('Could not clear the uploaded backgrounds, reset cancelled:', error);
      toast(variables.getMessage('toasts.error'));
      return;
    }
    setDefaultSettings('reset');
    window.location.reload();
  };

  return (
    <div className="smallModal">
      <div className="shareHeader">
        <span className="title">
          {variables.getMessage('modals.main.settings.sections.advanced.reset_modal.title')}
        </span>
        <Tooltip
          title={variables.getMessage('modals.main.settings.sections.advanced.reset_modal.cancel')}
        >
          <div className="close" onClick={modalClose}>
            <MdClose />
          </div>
        </Tooltip>
      </div>
      <span className="title">
        {variables.getMessage('modals.main.settings.sections.advanced.reset_modal.question')}
      </span>
      <span className="subtitle">
        {variables.getMessage('modals.main.settings.sections.advanced.reset_modal.information')}
      </span>
      <div className="resetFooter">
        <Button
          type="secondary"
          onClick={modalClose}
          icon={<MdClose />}
          label={variables.getMessage('modals.main.settings.sections.advanced.reset_modal.cancel')}
        />
        <Button
          type="settings"
          onClick={() => reset()}
          icon={<MdRestartAlt />}
          label={variables.getMessage('modals.main.settings.buttons.reset')}
        />
      </div>
    </div>
  );
}

const MemoizedResetModal = memo(ResetModal);

export { MemoizedResetModal as default, MemoizedResetModal as ResetModal };
