
export enum Status {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR',
}

export interface VoiceOption {
  name: string;
  value: 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
}

export interface LanguageOption {
  name: string;
  value: string;
}

export type ConversationTurn = {
  id: number;
  userInput: string;
  modelOutput: string;
  isComplete: boolean;
};
