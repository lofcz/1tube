import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface Props {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}

export function ApiKeyInput(
  { id, value, onChange, placeholder, autoComplete }: Props,
) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="key-input">
      <input
        id={id}
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete ?? "off"}
        spellCheck={false}
      />
      <button
        type="button"
        className="key-input-toggle"
        onClick={() => setReveal((r) => !r)}
        aria-label={reveal ? "Hide API key" : "Show API key"}
        title={reveal ? "Hide" : "Show"}
      >
        {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
