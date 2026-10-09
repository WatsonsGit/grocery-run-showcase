"use client";

/**
 * useVoiceDictation — a thin, library-free wrapper over the browser's
 * Web Speech API for dictating INTO A SINGLE STRING rather than chunking
 * into list items.
 *
 * Different shape from the grocery-list voice flow on purpose: that one
 * splits the transcript on commas / "and" and pushes each chunk as a
 * separate list row. This one keeps the transcript as one running
 * sentence, perfect for a chat/textarea surface.
 *
 * Capabilities:
 *  - SSR-safe (capability check guarded behind useSyncExternalStore).
 *  - `interim` exposes the live, not-yet-committed words so the UI can
 *    show a ghost preview while the user is still talking.
 *  - `onFinal` fires once per finalized chunk; the consumer decides what
 *    to do with it.
 *  - Self-stops on errors and on browser-side `onend` so a dropped
 *    session doesn't leave the UI thinking the mic is hot.
 *
 * Browser support: Chrome, Edge, Safari (16+), Opera. Firefox is the
 * notable gap; we return `supported: false` there and the UI hides the
 * mic button.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/* ---- Web Speech API typing (narrow shim, library-free) ---- */
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function subscribeNever(): () => void {
  return () => {};
}
function getSupportedClient(): boolean {
  return getSpeechRecognitionCtor() !== null;
}
function getSupportedServer(): boolean {
  return false;
}

export type VoiceDictation = {
  supported: boolean;
  listening: boolean;
  /** The current uncommitted transcript chunk; UI shows it as a ghost. */
  interim: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  error: string | null;
};

export function useVoiceDictation(opts: {
  /** Called once per finalized chunk. The consumer decides how to merge
   *  it into its own state (append, replace, split, etc.). */
  onFinal: (text: string) => void;
  /** BCP-47 locale. Defaults to "en-US". */
  lang?: string;
}): VoiceDictation {
  const { onFinal, lang = "en-US" } = opts;
  const supported = useSyncExternalStore(
    subscribeNever,
    getSupportedClient,
    getSupportedServer,
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Stash onFinal in a ref so we don't have to thread it through deps and
  // accidentally tear down + restart the recognition session on every render.
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const stop = useCallback(() => {
    const r = recognitionRef.current;
    if (r) {
      try {
        r.stop();
      } catch {
        // safe to swallow: already stopped
      }
    }
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const t = result[0].transcript;
        if (result.isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) {
        onFinalRef.current(finalText.trim());
        setInterim("");
      } else {
        setInterim(interimText);
      }
    };
    r.onerror = () => {
      stop();
    };
    r.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };
    recognitionRef.current = r;
    setListening(true);
    setError(null);
    try {
      r.start();
    } catch (e) {
      stop();
      setError(e instanceof Error ? e.message : "voice failed to start");
    }
  }, [lang, stop]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Tear down on unmount so navigating away kills the mic.
  useEffect(() => stop, [stop]);

  return { supported, listening, interim, start, stop, toggle, error };
}
