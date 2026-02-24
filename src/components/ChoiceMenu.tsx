import React, { useEffect, useRef } from 'react'
import type { MenuOption } from '../types'
import { stripRenpyTags } from '../textParser'

interface ChoiceMenuProps {
  choices: MenuOption[]
  onChoose: (index: number) => void
}

/**
 * Renders the choice menu overlay when the player reaches a `menu` step.
 *
 * Features:
 * - Keyboard navigation (arrow keys + Enter)
 * - Auto-focuses the first option on mount
 * - Strips Ren'Py markup from button labels for display
 * - Fade-in animation via CSS
 */
export const ChoiceMenu: React.FC<ChoiceMenuProps> = ({ choices, onChoose }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = React.useState(0)

  // Focus the container on mount so keyboard events work immediately
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Reset focused index when choices change
  useEffect(() => {
    setFocused(0)
  }, [choices])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        e.preventDefault()
        setFocused(prev => (prev + 1) % choices.length)
        break
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        e.preventDefault()
        setFocused(prev => (prev - 1 + choices.length) % choices.length)
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        onChoose(focused)
        break
      }
      // Number keys 1–9
      default: {
        const digit = parseInt(e.key, 10)
        if (!isNaN(digit) && digit >= 1 && digit <= choices.length) {
          e.preventDefault()
          onChoose(digit - 1)
        }
      }
    }
  }

  return (
    <div
      className="choice-overlay"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="请做出选择"
    >
      <div className="choice-container" role="list">
        {choices.map((option, index) => (
          <ChoiceButton
            key={index}
            index={index}
            text={option.text}
            isFocused={focused === index}
            onFocus={() => setFocused(index)}
            onClick={() => onChoose(index)}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Individual choice button ─────────────────────────────────────────────────

interface ChoiceButtonProps {
  index: number
  text: string
  isFocused: boolean
  onFocus: () => void
  onClick: () => void
}

const ChoiceButton: React.FC<ChoiceButtonProps> = ({
  index,
  text,
  isFocused,
  onFocus,
  onClick,
}) => {
  const btnRef = useRef<HTMLButtonElement>(null)

  // Scroll focused button into view
  useEffect(() => {
    if (isFocused) {
      btnRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isFocused])

  // Strip Ren'Py tags from display text
  const displayText = stripRenpyTags(text)

  return (
    <button
      ref={btnRef}
      className={`choice-btn${isFocused ? ' focused' : ''}`}
      role="listitem"
      tabIndex={isFocused ? 0 : -1}
      onClick={onClick}
      onMouseEnter={onFocus}
      onFocus={onFocus}
      aria-label={`选项 ${index + 1}: ${displayText}`}
      style={
        isFocused
          ? {
              background: 'rgba(233, 69, 96, 0.65)',
              borderColor: 'rgba(233, 69, 96, 0.9)',
              transform: 'translateX(6px)',
              boxShadow: '0 4px 16px rgba(233, 69, 96, 0.3)',
            }
          : undefined
      }
    >
      <span
        style={{
          fontSize: '0.8rem',
          opacity: 0.6,
          marginRight: '0.6rem',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {index + 1}.
      </span>
      {displayText}
    </button>
  )
}
