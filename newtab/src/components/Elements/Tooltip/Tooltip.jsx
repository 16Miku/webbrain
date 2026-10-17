import { useState, memo, useRef, useId, isValidElement, cloneElement } from 'react';
import { useFloating, flip, offset, shift } from '@floating-ui/react-dom';
import './tooltip.scss';

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

function Tooltip({ children, title, style, placement, subtitle }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [reference, setReference] = useState(null);
  const tooltipId = `tooltip-${useId().replace(/:/g, '')}`;
  const closeTimeout = useRef(null);

  const {
    x,
    y,
    refs,
    strategy,
    placement: computedPlacement,
  } = useFloating({
    placement: placement || 'bottom',
    middleware: [flip(), offset(15), shift()],
    elements: {
      reference,
    },
  });

  const handleMouseEnter = () => {
    // Clear any pending close timeout if mouse re-enters during exit
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current);
      closeTimeout.current = null;
    }
    setIsClosing(false);
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    setIsClosing(true);
    // Wait for exit animation to complete before unmounting
    closeTimeout.current = setTimeout(() => {
      setShowTooltip(false);
      setIsClosing(false);
    }, 200); // Match exit animation duration
  };

  const handleFocus = () => {
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current);
      closeTimeout.current = null;
    }
    setIsClosing(false);
    setShowTooltip(true);
  };

  const handleBlur = () => {
    setIsClosing(true);
    closeTimeout.current = setTimeout(() => {
      setShowTooltip(false);
      setIsClosing(false);
    }, 200);
  };

  // Determine the data-status attribute value
  const getStatus = () => {
    if (!showTooltip && !isClosing) return 'initial';
    if (isClosing) return 'close';
    return 'open';
  };

  return (
    <>
      <div
        className="tooltip"
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        ref={setReference}
      >
        {/* The focusable control (not this wrapper) carries the description, and the id it points
            at always exists: a visually hidden copy of the text, since the visible tooltip is only
            mounted while shown. */}
        {isValidElement(children) && !children.props['aria-describedby']
          ? cloneElement(children, { 'aria-describedby': tooltipId })
          : children}
        <span id={tooltipId} role="tooltip" style={VISUALLY_HIDDEN}>
          {title}
          {subtitle ? ` ${subtitle}` : ''}
        </span>
      </div>
      {(showTooltip || isClosing) && (
        <span
          ref={refs.setFloating}
          style={{
            position: strategy,
            top: y ?? '',
            left: x ?? '',
            display: 'flex',
            flexFlow: 'column',
          }}
          className="tooltipTitle"
          data-status={getStatus()}
          data-placement={computedPlacement}
        >
          {title}
          <span style={{ fontSize: '8px' }}>{subtitle}</span>
        </span>
      )}
    </>
  );
}

const MemoizedTooltip = memo(Tooltip);

export { MemoizedTooltip as default, MemoizedTooltip as Tooltip };
