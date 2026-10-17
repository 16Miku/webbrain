import { useState, useEffect } from 'react';
import Modal from 'react-modal';

import { MainModal } from 'components/Elements';
import Navbar from '../../navbar/Navbar';

import EventBus from 'utils/eventbus';
import { parseDeepLink, shouldAutoOpenModal, updateHash } from 'utils/deepLinking';

const Modals = () => {
  const [mainModal, setMainModal] = useState(false);
  const [deepLinkData, setDeepLinkData] = useState(null);

  useEffect(() => {
    if (shouldAutoOpenModal()) {
      setDeepLinkData(parseDeepLink());
      setMainModal(true);
    }

    const handleModalOpen = (data) => {
      if (data === 'openMainModal') {
        setDeepLinkData(parseDeepLink());
        setMainModal(true);
      }
    };

    EventBus.on('modal', handleModalOpen);

    return () => {
      EventBus.off('modal', handleModalOpen);
    };
  }, []);

  const toggleMainModal = (action) => {
    setMainModal(action);
    // A route the modal was first opened with must not come back the next time it opens.
    setDeepLinkData(null);
    if (action !== false) {
      updateHash('#settings');
    }
  };

  return (
    <>
      <Navbar openModal={() => toggleMainModal(true)} />
      <Modal
        closeTimeoutMS={300}
        id="modal"
        onRequestClose={() => toggleMainModal(false)}
        isOpen={mainModal}
        className="Modal mainModal"
        overlayClassName="Overlay"
        ariaHideApp={false}
      >
        <MainModal modalClose={() => toggleMainModal(false)} deepLinkData={deepLinkData} />
      </Modal>
    </>
  );
};

export { Modals as default, Modals };
