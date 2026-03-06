import React, { useState, useEffect, useRef } from "react";

interface InputOverlayProps {
  prompt: string;
  onSubmit: (value: string) => void;
}

export const InputOverlay: React.FC<InputOverlayProps> = ({
  prompt,
  onSubmit,
}) => {
  const [value, setValue] = useState("");
  const [prevPrompt, setPrevPrompt] = useState(prompt);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset input value when the prompt changes (derived state pattern).
  if (prevPrompt !== prompt) {
    setPrevPrompt(prompt);
    setValue("");
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, [prompt]);

  const handleSubmit = () => {
    onSubmit(value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        zIndex: 40,
      }}
    >
      <div
        style={{
          background: "#1a1a2e",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: "8px",
          padding: "24px 32px",
          minWidth: "320px",
          maxWidth: "480px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <p
          style={{
            margin: 0,
            color: "#e0e0e0",
            fontSize: "1rem",
            textAlign: "center",
          }}
        >
          {prompt}
        </p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.3)",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "1rem",
            padding: "8px 12px",
            outline: "none",
          }}
        />
        <button
          onClick={handleSubmit}
          style={{
            background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.3)",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "0.9rem",
            padding: "8px",
            cursor: "pointer",
          }}
        >
          确认
        </button>
      </div>
    </div>
  );
};
