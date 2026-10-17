import { MdOutlineKeyboardArrowRight } from 'react-icons/md';
import React from 'react';

function Section({ title, subtitle, icon, onClick, children }) {
  return (
    <div
      className="moreSettings"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        // Only the card itself: keys pressed in a control inside it belong to that control.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.(event);
        }
      }}
    >
      <div className="left">
        {icon}
        <div className="content">
          <span className="title">{title}</span>
          <span className="subtitle">{subtitle}</span>
        </div>
      </div>
      <div className="action">
        {React.Children.count(children) === 0 ? <MdOutlineKeyboardArrowRight /> : children}
      </div>
    </div>
  );
}

export { Section as default, Section };
