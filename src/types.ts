export interface Word {
  id: string;
  word: string;
  definition: string;
  example?: string;
}

export interface WordBank {
  id: string;
  name: string;
  words: Word[];
}

export type WordStatus = 'mastered' | 'familiar' | 'unfamiliar' | 'new';

export interface Stats {
  mastered: number;
  familiar: number;
  unfamiliar: number;
}

export interface UserProgress {
  wordStatus: Record<string, WordStatus>;
  missionsFinished: number;
}

export interface GameState {
  currentRoundWords: Word[];
  currentIndex: number;
  score: number;
  incorrectWords: Word[];
  isFinished: boolean;
  showHint: boolean;
  hintLevel: number; // 0: none, 1: first letter, 2: first half, 3: full word + picture
  userInput: string;
  feedback: 'correct' | 'incorrect' | null;
  sessionStats: Stats;
  attempts: number;
}
