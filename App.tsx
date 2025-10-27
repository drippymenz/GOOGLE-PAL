
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, Blob } from '@google/genai';
import { Status, ConversationTurn } from './types';
import { LANGUAGES, VOICES } from './constants';
import { encode, decode, decodeAudioData } from './utils/audioUtils';
import Icon from './components/Icon';

const ConversationBubble: React.FC<{ turn: ConversationTurn }> = ({ turn }) => {
  return (
    <>
      <div className="flex justify-end mb-4">
        <div className="bg-blue-600 rounded-lg px-4 py-2 max-w-sm md:max-w-md">
          <p className="text-white">{turn.userInput || "..."}</p>
        </div>
      </div>
      {(turn.modelOutput || !turn.isComplete) && (
        <div className="flex justify-start mb-4">
          <div className="bg-gray-700 rounded-lg p-2 mr-2 self-start flex-shrink-0">
            <Icon name="robot" className="w-6 h-6 text-cyan-400" />
          </div>
          <div className="bg-gray-700 rounded-lg px-4 py-2 max-w-sm md:max-w-md">
            <p className="text-white">{turn.modelOutput || "..."}</p>
          </div>
        </div>
      )}
    </>
  );
};

export default function App() {
  const [status, setStatus] = useState<Status>(Status.IDLE);
  const [transcript, setTranscript] = useState<ConversationTurn[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>(LANGUAGES[0].value);
  const [selectedVoice, setSelectedVoice] = useState<string>(VOICES[0].value);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextAudioStartTimeRef = useRef(0);
  
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
  }, []);

  const updateTranscript = useCallback((newTurn: Partial<ConversationTurn>) => {
    setTranscript(prev => {
      const existingTurnIndex = prev.findIndex(t => t.id === newTurn.id);
      if (existingTurnIndex !== -1) {
        return prev.map((t, i) => i === existingTurnIndex ? { ...t, ...newTurn } : t);
      } else if(newTurn.id !== undefined) {
        return [...prev, {id: newTurn.id, userInput: '', modelOutput: '', isComplete: false, ...newTurn}];
      }
      return prev;
    });
  }, []);

  const handleStop = useCallback(async () => {
    setStatus(Status.IDLE);
    if (sessionPromiseRef.current) {
        try {
            const session = await sessionPromiseRef.current;
            session.close();
        } catch (e) {
            console.error("Error closing session", e);
        }
        sessionPromiseRef.current = null;
    }
    
    scriptProcessorRef.current?.disconnect();
    scriptProcessorRef.current = null;
    
    microphoneStreamRef.current?.getTracks().forEach(track => track.stop());
    microphoneStreamRef.current = null;
    
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      inputAudioContextRef.current.close();
    }
    inputAudioContextRef.current = null;

    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      outputAudioContextRef.current.close();
    }
    outputAudioContextRef.current = null;

    audioSourcesRef.current.forEach(source => source.stop());
    audioSourcesRef.current.clear();
    nextAudioStartTimeRef.current = 0;
  }, []);

  const handleStart = useCallback(async () => {
    setStatus(Status.CONNECTING);
    setErrorMessage(null);
    setTranscript([]);

    if (!aiRef.current) {
      setStatus(Status.ERROR);
      setErrorMessage("Gemini AI not initialized.");
      return;
    }

    try {
      // Fix: Cast window to `any` to support `webkitAudioContext` for older browsers.
      inputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      // Fix: Cast window to `any` to support `webkitAudioContext` for older browsers.
      outputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneStreamRef.current = stream;

      const ai = aiRef.current;
      
      let currentInputTranscription = '';
      let currentOutputTranscription = '';
      let currentTurnId = Date.now();
      
      updateTranscript({ id: currentTurnId, isComplete: false });

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice as any } },
          },
          systemInstruction: `You are a friendly language tutor. The user wants to practice speaking ${selectedLanguage}. Keep your responses concise and encourage the user to speak. Correct their grammar and pronunciation mistakes gently. Start the conversation now.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(Status.LISTENING);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription += message.serverContent.inputTranscription.text;
              updateTranscript({ id: currentTurnId, userInput: currentInputTranscription });
            }

            if (message.serverContent?.outputTranscription) {
              setStatus(Status.SPEAKING);
              currentOutputTranscription += message.serverContent.outputTranscription.text;
              updateTranscript({ id: currentTurnId, modelOutput: currentOutputTranscription });
            }

            const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
            if (base64EncodedAudioString && outputAudioContextRef.current) {
              const outputAudioContext = outputAudioContextRef.current;
              nextAudioStartTimeRef.current = Math.max(nextAudioStartTimeRef.current, outputAudioContext.currentTime);

              const audioBuffer = await decodeAudioData(decode(base64EncodedAudioString), outputAudioContext, 24000, 1);

              const sourceNode = outputAudioContext.createBufferSource();
              sourceNode.buffer = audioBuffer;
              sourceNode.connect(outputAudioContext.destination);
              sourceNode.addEventListener('ended', () => {
                audioSourcesRef.current.delete(sourceNode);
                if (audioSourcesRef.current.size === 0) {
                   setStatus(Status.LISTENING);
                }
              });
              sourceNode.start(nextAudioStartTimeRef.current);
              nextAudioStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(sourceNode);
            }

            if (message.serverContent?.turnComplete) {
              updateTranscript({ id: currentTurnId, isComplete: true });
              currentInputTranscription = '';
              currentOutputTranscription = '';
              currentTurnId = Date.now();
              updateTranscript({ id: currentTurnId, isComplete: false });
            }
            
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
                audioSourcesRef.current.forEach(source => source.stop());
                audioSourcesRef.current.clear();
                nextAudioStartTimeRef.current = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("Session error", e);
            setErrorMessage("An error occurred with the connection.");
            setStatus(Status.ERROR);
            handleStop();
          },
          onclose: (e: CloseEvent) => {
             console.log("Session closed");
          },
        },
      });

    } catch (error) {
      console.error("Failed to start session:", error);
      let message = "An unknown error occurred.";
      if (error instanceof Error) {
        if(error.name === 'NotAllowedError') {
          message = "Microphone access was denied. Please allow microphone access in your browser settings.";
        } else {
          message = error.message;
        }
      }
      setErrorMessage(message);
      setStatus(Status.ERROR);
    }
  }, [selectedLanguage, selectedVoice, updateTranscript, handleStop]);
  
  function renderMainButton() {
    const isConnecting = status === Status.CONNECTING;
    const isIdle = status === Status.IDLE;

    if (isIdle || status === Status.ERROR) {
      return (
        <button
          onClick={handleStart}
          disabled={isConnecting}
          className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-500 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-full flex items-center justify-center w-24 h-24 shadow-lg transition-transform transform hover:scale-105"
          aria-label="Start conversation"
        >
          {isConnecting ? <Icon name="spinner" className="animate-spin w-8 h-8" /> : <Icon name="microphone" className="w-8 h-8" />}
        </button>
      );
    } else {
      return (
        <button
          onClick={handleStop}
          className="bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-full flex items-center justify-center w-24 h-24 shadow-lg transition-transform transform hover:scale-105"
          aria-label="Stop conversation"
        >
          <Icon name="stop" className="w-8 h-8" />
        </button>
      );
    }
  }

  function renderStatusIndicator() {
    switch(status) {
      case Status.IDLE:
        return <p className="text-gray-400">Ready to start</p>;
      case Status.CONNECTING:
        return <p className="text-yellow-400 flex items-center justify-center gap-2"><Icon name="spinner" className="animate-spin w-5 h-5" /> Connecting...</p>;
      case Status.LISTENING:
        return <p className="text-green-400 animate-pulse">Listening...</p>;
      case Status.SPEAKING:
        return <p className="text-blue-400">Tutor is speaking...</p>;
      case Status.ERROR:
        return <p className="text-red-400">Error</p>;
      default:
        return null;
    }
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-sans">
      <header className="bg-gray-800 p-4 shadow-md">
        <h1 className="text-2xl font-bold text-center text-cyan-400">Gemini Language Pal</h1>
        <p className="text-center text-gray-400">Your AI partner for language practice</p>
      </header>
      
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-3xl mx-auto">
          {transcript.length === 0 && status === Status.IDLE && (
            <div className="text-center text-gray-400 p-8 border-2 border-dashed border-gray-600 rounded-lg">
                <p className="text-lg">Select your desired language and voice, then press "Start Conversation" to begin practicing!</p>
            </div>
          )}
          
          {transcript.map(turn => (
            <ConversationBubble key={turn.id} turn={turn} />
          ))}
          <div ref={conversationEndRef} />
        </div>
      </main>

      <footer className="bg-gray-800 p-4 shadow-inner">
        <div className="max-w-3xl mx-auto flex flex-col items-center gap-4">
          {status === Status.IDLE && (
            <div className="flex flex-col md:flex-row gap-4 w-full">
              <div className="flex-1">
                <label htmlFor="language-select" className="block text-sm font-medium text-gray-300 mb-1">Language</label>
                <select 
                  id="language-select"
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 focus:ring-cyan-500 focus:border-cyan-500"
                  aria-label="Select practice language"
                >
                  {LANGUAGES.map(lang => <option key={lang.value} value={lang.value}>{lang.name}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="voice-select" className="block text-sm font-medium text-gray-300 mb-1">Tutor's Voice</label>
                <select 
                  id="voice-select"
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 focus:ring-cyan-500 focus:border-cyan-500"
                  aria-label="Select tutor's voice"
                >
                  {VOICES.map(voice => <option key={voice.value} value={voice.value}>{voice.name}</option>)}
                </select>
              </div>
            </div>
          )}
          
          {errorMessage && (
            <div className="bg-red-900/50 border border-red-500 text-red-300 px-4 py-2 rounded-md text-center">
              <p>{errorMessage}</p>
            </div>
          )}
          
          <div className="flex items-center gap-4">
            {renderMainButton()}
            <div className="w-48 text-center">{renderStatusIndicator()}</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
