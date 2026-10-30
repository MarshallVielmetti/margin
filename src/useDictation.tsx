import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
interface SpeechResult {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}
interface SpeechEngine {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechResult) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechEngine;
  webkitSpeechRecognition?: new () => SpeechEngine;
};
export function useDictation(onError: (message: string) => void) {
  const recognition = useRef<SpeechEngine | null>(null);
  const [active, setActive] = useState(false);
  const stop = () => {
    recognition.current?.stop();
    setActive(false);
  };
  useEffect(() => () => recognition.current?.stop(), []);
  const start = (
    onFinal: (text: string) => void,
    onInterim: (text: string) => void,
  ) => {
    if (active) {
      stop();
      return;
    }
    const Engine =
      (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition;
    if (!Engine) {
      onError(
        "Browser dictation is unavailable. Use macOS dictation in this text field, or type normally.",
      );
      return;
    }
    const engine = new Engine();
    recognition.current = engine;
    engine.continuous = true;
    engine.interimResults = true;
    engine.lang = "en-US";
    // Callbacks are captured for this utterance. A late final never follows focus.
    engine.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) onFinal(event.results[i][0].transcript);
        else interim += event.results[i][0].transcript;
      }
      onInterim(interim);
    };
    engine.onerror = (event) => {
      if (recognition.current === engine) setActive(false);
      onError(
        `Dictation stopped: ${event.error}. Final and unfinished text remain recoverable.`,
      );
    };
    engine.onend = () => {
      if (recognition.current === engine) setActive(false);
    };
    try {
      engine.start();
      setActive(true);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return { active, start, stop };
}
export function DictationButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "dictating" : ""}`}
      aria-label={active ? "Stop dictation" : "Start dictation"}
      aria-pressed={active}
      onClick={onClick}
    >
      {active ? <MicOff size={17} /> : <Mic size={17} />}
    </button>
  );
}
