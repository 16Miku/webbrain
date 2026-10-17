import { MdOutlineKeyboardArrowRight } from 'react-icons/md';

const NavigationCard = ({ icon: Icon, title, subtitle, onClick, action }) => {
  return (
    <div className="moreSettings" onClick={onClick}>
      <div
        className="left"
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick?.(event);
          }
        }}
      >
        <Icon />
        <div className="content">
          <span className="title">{title}</span>
          <span className="subtitle">{subtitle}</span>
        </div>
      </div>
      {/* A control placed here (a dropdown) is used in place; it must not open the card. */}
      <div className="action" onClick={action ? (event) => event.stopPropagation() : undefined}>
        {action || <MdOutlineKeyboardArrowRight />}
      </div>
    </div>
  );
};

export default NavigationCard;
