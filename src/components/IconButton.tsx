import React from "react";

interface IconButtonProps {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  disabled = false,
  onClick,
}) => (
  <button
    className={`icon-btn${disabled ? " icon-btn--disabled" : ""}`}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  >
    <span role="img" aria-label={label}>
      {icon}
    </span>
  </button>
);
