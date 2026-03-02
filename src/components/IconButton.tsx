import React from "react";

interface IconButtonProps {
  icon: string;
  label: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  disabled = false,
  title,
  onClick,
}) => (
  <button
    className={`icon-btn${disabled ? " icon-btn--disabled" : ""}`}
    aria-label={label}
    title={title}
    disabled={disabled}
    onClick={onClick}
  >
    <span role="img" aria-label={label}>
      {icon}
    </span>
  </button>
);
