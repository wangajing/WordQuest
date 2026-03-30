/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { useState, useEffect, useMemo, Component } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Rocket, Star, Orbit, ChevronRight, ChevronDown, RotateCcw, Lightbulb, CheckCircle2, XCircle, Trophy, BookOpen, Search, ArrowLeft, Volume2, Sparkles, LogIn, LogOut, Cloud, CloudOff } from 'lucide-react';
import confetti from 'canvas-confetti';
import { ALL_WORD_BANKS, WORD_BANK_2 } from './constants';
import { Word, GameState, Stats, WordStatus, UserProgress, WordBank } from './types';
import { auth, db, loginWithGoogle, logout, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';

const WORDS_PER_ROUND = 10;

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    // @ts-ignore
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    // @ts-ignore
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6 text-center">
          <div className="glass-card p-8 max-w-md w-full border-red-500/20">
            <XCircle size={64} className="text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white mb-4 font-display">System Malfunction</h1>
            <p className="text-blue-200 mb-6">
              {/* @ts-ignore */}
              {this.state.error?.message?.includes('authInfo') 
                ? "A communication error occurred with the galactic database. Please check your connection." 
                : "An unexpected error occurred in the navigation system."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-xl transition-all shadow-lg shadow-blue-500/20"
            >
              Reboot System
            </button>
          </div>
        </div>
      );
    }
    // @ts-ignore
    return this.props.children;
  }
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

function App() {
  const [gameState, setGameState] = useState<GameState>({
    currentRoundWords: [],
    currentIndex: 0,
    score: 0,
    incorrectWords: [],
    isFinished: false,
    showHint: false,
    hintLevel: 0,
    userInput: '',
    feedback: null,
    sessionStats: { mastered: 0, familiar: 0, unfamiliar: 0 },
  });

  const [view, setView] = useState<'home' | 'mission' | 'browse'>('home');
  const [wordStatus, setWordStatus] = useState<Record<string, WordStatus>>({});
  const [missionsFinished, setMissionsFinished] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBankId, setSelectedBankId] = useState<string>(WORD_BANK_2.id);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBankMenuOpen, setIsBankMenuOpen] = useState(false);
  const [lastSyncedData, setLastSyncedData] = useState<string>('');

  const currentBank = useMemo(() => 
    ALL_WORD_BANKS.find(b => b.id === selectedBankId) || WORD_BANK_2
  , [selectedBankId]);

  // Derive totalStats from wordStatus for the current bank
  const totalStats = useMemo(() => {
    const stats: Stats = { mastered: 0, familiar: 0, unfamiliar: 0 };
    currentBank.words.forEach(word => {
      const status = wordStatus[word.id];
      if (status === 'mastered') stats.mastered++;
      if (status === 'familiar') stats.familiar++;
      if (status === 'unfamiliar') stats.unfamiliar++;
    });
    return stats;
  }, [wordStatus, currentBank]);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Firestore sync
  useEffect(() => {
    if (!user) return;

    const userDocRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      // Avoid overwriting local state if we have pending writes
      if (docSnap.metadata.hasPendingWrites) return;

      if (docSnap.exists()) {
        const data = docSnap.data();
        
        // Update local state only if it differs from server to prevent loops
        const serverDataStr = JSON.stringify({
          wordStatus: data.wordStatus,
          missionsFinished: data.missionsFinished,
          selectedBankId: data.selectedBankId
        });

        if (serverDataStr !== lastSyncedData) {
          setWordStatus(data.wordStatus || {});
          setMissionsFinished(data.missionsFinished || 0);
          if (data.selectedBankId) setSelectedBankId(data.selectedBankId);
          setLastSyncedData(serverDataStr);
        }
      } else {
        // First time user, upload local progress
        const localProgress = localStorage.getItem('wordquest_progress');
        if (localProgress) {
          try {
            const progress = JSON.parse(localProgress);
            setDoc(userDocRef, {
              uid: user.uid,
              wordStatus: progress.wordStatus || {},
              missionsFinished: progress.missionsFinished || 0,
              selectedBankId: progress.selectedBankId || selectedBankId,
              lastUpdated: serverTimestamp()
            }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
          } catch (e) {}
        }
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `users/${user.uid}`));

    return () => unsubscribe();
  }, [user]);

  // Save progress to localStorage (frequent)
  useEffect(() => {
    const progress: UserProgress = { 
      wordStatus, 
      missionsFinished,
      selectedBankId,
      lastUpdated: new Date().toISOString()
    };
    localStorage.setItem('wordquest_progress', JSON.stringify(progress));
  }, [wordStatus, missionsFinished, selectedBankId]);

  // Sync to Firestore (Debounced to prevent traffic storms)
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const currentData = {
      wordStatus,
      missionsFinished,
      selectedBankId
    };
    const currentDataStr = JSON.stringify(currentData);

    // Only sync if data has actually changed from the last known server state
    if (currentDataStr === lastSyncedData) return;

    const timeoutId = setTimeout(() => {
      setIsSyncing(true);
      setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        ...currentData,
        lastUpdated: serverTimestamp()
      }, { merge: true })
      .then(() => {
        setIsSyncing(false);
        setLastSyncedData(currentDataStr);
      })
      .catch(err => {
        setIsSyncing(false);
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      });
    }, 2000); // 2 second debounce

    return () => clearTimeout(timeoutId);
  }, [missionsFinished, user, wordStatus, selectedBankId, isAuthReady, lastSyncedData]);

  // Initialize a round
  const startNewRound = () => {
    const bankWords = currentBank.words;
    const masteredWords = bankWords.filter(w => wordStatus[w.id] === 'mastered');
    const familiarWords = bankWords.filter(w => wordStatus[w.id] === 'familiar');
    const unfamiliarWords = bankWords.filter(w => wordStatus[w.id] === 'unfamiliar');
    const newWords = bankWords.filter(w => !wordStatus[w.id] || wordStatus[w.id] === 'new');

    const roundWords: Word[] = [];

    // 1. Pick exactly two new words (for new stuff)
    const shuffledNew = [...newWords].sort(() => 0.5 - Math.random());
    const neededNew = Math.min(2, shuffledNew.length);
    roundWords.push(...shuffledNew.slice(0, neededNew));

    // 2. Pick the rest from learning (unfamiliar) and familiar words
    const priorityPool = [...unfamiliarWords, ...familiarWords].sort(() => 0.5 - Math.random());
    const neededPriority = Math.min(WORDS_PER_ROUND - roundWords.length, priorityPool.length);
    roundWords.push(...priorityPool.slice(0, neededPriority));

    // 3. Fallback: if still not enough, fill with anything else remaining (excluding mastered)
    if (roundWords.length < WORDS_PER_ROUND) {
      const remainingWords = bankWords.filter(w => 
        !roundWords.find(rw => rw.id === w.id) && 
        wordStatus[w.id] !== 'mastered'
      );
      const shuffledRemaining = [...remainingWords].sort(() => 0.5 - Math.random());
      const neededRemaining = Math.min(WORDS_PER_ROUND - roundWords.length, shuffledRemaining.length);
      roundWords.push(...shuffledRemaining.slice(0, neededRemaining));
    }

    // 4. Ultimate Fallback: If we still don't have enough (e.g. almost everything is mastered), 
    // then and only then allow mastered words to fill the gap
    if (roundWords.length < WORDS_PER_ROUND) {
      const masteredFallback = bankWords.filter(w => !roundWords.find(rw => rw.id === w.id));
      const shuffledMastered = [...masteredFallback].sort(() => 0.5 - Math.random());
      const neededMastered = Math.min(WORDS_PER_ROUND - roundWords.length, shuffledMastered.length);
      roundWords.push(...shuffledMastered.slice(0, neededMastered));
    }

    // Final shuffle of the round words
    const finalRoundWords = [...roundWords].sort(() => 0.5 - Math.random());

    setGameState({
      currentRoundWords: finalRoundWords,
      currentIndex: 0,
      score: 0,
      incorrectWords: [],
      isFinished: false,
      showHint: false,
      hintLevel: 0,
      userInput: '',
      feedback: null,
      sessionStats: { mastered: 0, familiar: 0, unfamiliar: 0 },
      attempts: 0,
    });
    setView('mission');
  };

  const exitToHome = () => {
    setView('home');
    setGameState(prev => ({ ...prev, isFinished: false }));
    setIsBankMenuOpen(false);
  };

  const filteredWords = useMemo(() => {
    return currentBank.words.filter(w => 
      w.word.toLowerCase().includes(searchQuery.toLowerCase()) || 
      w.definition.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, currentBank]);

  const getRank = () => {
    const total = totalStats.mastered;
    const bankSize = currentBank.words.length;
    const percent = bankSize > 0 ? (total / bankSize) * 100 : 0;

    if (percent >= 100) return { name: 'Galactic Master', icon: '🌌', color: 'text-yellow-400' };
    if (percent >= 75) return { name: 'Star Commander', icon: '⭐', color: 'text-blue-400' };
    if (percent >= 50) return { name: 'Planet Explorer', icon: '🪐', color: 'text-purple-400' };
    if (percent >= 25) return { name: 'Space Pilot', icon: '🚀', color: 'text-green-400' };
    return { name: 'Space Cadet', icon: '👨‍🚀', color: 'text-gray-400' };
  };

  const currentWord = gameState.currentRoundWords[gameState.currentIndex];

  const handleCheck = () => {
    if (!currentWord || gameState.feedback || !gameState.userInput.trim()) return;

    const isCorrect = gameState.userInput.trim().toLowerCase() === currentWord.word.toLowerCase();
    
    if (isCorrect) {
      // Categorize the word based on hint level and attempts
      let category: WordStatus = 'familiar';
      if (gameState.hintLevel === 0 && gameState.attempts === 0) {
        category = 'mastered';
      } else if (gameState.hintLevel === 3) {
        category = 'unfamiliar';
      }

      // Update word status
      setWordStatus(prev => ({
        ...prev,
        [currentWord.id]: category
      }));

      // If they used the full hint, they must type it correctly to proceed, 
      // but it counts as incorrect for the round (will repeat later)
      if (gameState.hintLevel === 3) {
        setGameState(prev => ({
          ...prev,
          feedback: 'correct',
          sessionStats: {
            ...prev.sessionStats,
            unfamiliar: prev.sessionStats.unfamiliar + 1
          }
        }));
        
        setTimeout(() => {
          moveToNext(true); // shouldRepeat = true
        }, 3000);
        return;
      }

      confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#60a5fa', '#3b82f6', '#2563eb', '#ffffff']
      });
      
      setGameState(prev => ({
        ...prev,
        feedback: 'correct',
        score: prev.score + 1,
        sessionStats: {
          ...prev.sessionStats,
          [category === 'mastered' ? 'mastered' : category === 'familiar' ? 'familiar' : 'unfamiliar']: 
            prev.sessionStats[category === 'mastered' ? 'mastered' : category === 'familiar' ? 'familiar' : 'unfamiliar'] + 1
        }
      }));

      setTimeout(() => {
        moveToNext(false); // shouldRepeat = false
      }, 3000);
    } else {
      setGameState(prev => ({
        ...prev,
        feedback: 'incorrect',
        attempts: prev.attempts + 1,
        hintLevel: Math.min(prev.hintLevel + 1, 3),
        showHint: true,
      }));

      // Clear feedback after 1s so they can try again
      setTimeout(() => {
        setGameState(prev => ({
          ...prev,
          feedback: null,
          userInput: '', // Clear input for retry
        }));
      }, 1000);
    }
  };

  const moveToNext = (shouldRepeat: boolean) => {
    setGameState(prev => {
      const nextIndex = prev.currentIndex + 1;
      const currentWordToProcess = prev.currentRoundWords[prev.currentIndex];
      
      // Accumulate incorrect words correctly using the previous state
      const newIncorrectWords = shouldRepeat 
        ? [...prev.incorrectWords, currentWordToProcess] 
        : prev.incorrectWords;
      
      if (nextIndex >= prev.currentRoundWords.length) {
        if (newIncorrectWords.length > 0) {
          return {
            ...prev,
            currentRoundWords: [...newIncorrectWords],
            incorrectWords: [],
            currentIndex: 0,
            userInput: '',
            feedback: null,
            showHint: false,
            hintLevel: 0,
            attempts: 0,
          };
        } else {
          // Mission Finished!
          setMissionsFinished(m => {
            const next = m + 1;
            if (next % 5 === 0) {
              setTimeout(() => {
                confetti({
                  particleCount: 400,
                  spread: 120,
                  origin: { y: 0.5 },
                  colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#ffffff']
                });
              }, 500);
            }
            return next;
          });
          return {
            ...prev,
            isFinished: true,
            feedback: null,
          };
        }
      }

      return {
        ...prev,
        currentIndex: nextIndex,
        userInput: '',
        feedback: null,
        showHint: false,
        hintLevel: 0,
        attempts: 0,
        incorrectWords: newIncorrectWords, // Keep track of incorrect words for the end of the round
      };
    });
  };

  const skipWord = () => {
    if (gameState.feedback) return;
    
    // When skipping, we treat it as "unfamiliar" and repeat it
    setGameState(prev => ({
      ...prev,
      feedback: 'incorrect',
      sessionStats: {
        ...prev.sessionStats,
        unfamiliar: prev.sessionStats.unfamiliar + 1
      }
    }));

    setTimeout(() => {
      moveToNext(true); // true means shouldRepeat
    }, 1000);
  };

  const speakWord = (word: string) => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.rate = 0.9;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleHint = () => {
    setGameState(prev => {
      const nextLevel = Math.min(prev.hintLevel + 1, 3);
      return { 
        ...prev, 
        showHint: true,
        hintLevel: nextLevel,
      };
    });
  };

  const getHintText = () => {
    if (!currentWord) return '';
    const word = currentWord.word;
    if (gameState.hintLevel === 1) return word[0] + '_'.repeat(word.length - 1);
    if (gameState.hintLevel === 2) return word.substring(0, Math.ceil(word.length / 2)) + '_'.repeat(word.length - Math.ceil(word.length / 2));
    if (gameState.hintLevel === 3) return word;
    return '';
  };

  if (view === 'home') {
    return (
      <div className="space-bg flex flex-col items-center justify-center p-6 text-center relative overflow-hidden">
        <div className="stars" />
        
        {/* Persistent App Icon & Auth */}
        <div className="absolute top-6 left-6 right-6 z-50 flex items-center justify-between">
          <div className="flex items-center gap-2 opacity-80 hover:opacity-100 transition-opacity cursor-default">
            <div className="bg-blue-500/20 p-2 rounded-lg backdrop-blur-sm border border-white/10">
              <Rocket size={20} className="text-blue-400" />
            </div>
            <span className="text-xs font-black tracking-tighter text-white uppercase font-display hidden sm:block">WordQuest</span>
          </div>

          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3 bg-white/5 p-1 pr-3 rounded-full border border-white/10 backdrop-blur-sm">
                <img 
                  src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName || 'User'}`} 
                  alt="Profile" 
                  className="w-8 h-8 rounded-full border border-white/20"
                  referrerPolicy="no-referrer"
                />
                <div className="hidden md:block text-left">
                  <p className="text-[10px] font-bold text-white leading-none">{user.displayName}</p>
                  <div className="flex items-center gap-1">
                    {isSyncing ? (
                      <span className="text-[8px] text-blue-400 animate-pulse">Syncing...</span>
                    ) : (
                      <>
                        <Cloud size={8} className="text-green-400" />
                        <span className="text-[8px] text-green-400/70">Synced</span>
                      </>
                    )}
                  </div>
                </div>
                <button 
                  onClick={() => logout()}
                  className="text-white/40 hover:text-red-400 transition-colors p-1"
                  title="Sign Out"
                >
                  <LogOut size={16} />
                </button>
              </div>
            ) : (
              <button 
                onClick={() => loginWithGoogle()}
                className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-white text-xs font-bold py-2 px-4 rounded-full border border-white/10 backdrop-blur-sm transition-all"
              >
                <LogIn size={14} />
                Sign In
              </button>
            )}
          </div>
        </div>

        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="z-10 w-full max-w-lg"
        >
          <div className="mb-8 flex justify-center relative">
            <motion.div
              animate={{ y: [0, -10, 0], rotate: [0, 5, -5, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut" }}
              className="relative"
            >
              <div className="absolute inset-0 bg-blue-500/20 blur-3xl rounded-full" />
              <Rocket size={80} className="text-blue-400 relative z-10 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]" />
              <motion.div
                animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                transition={{ repeat: Infinity, duration: 2 }}
                className="absolute -top-4 -right-4"
              >
                <Sparkles size={32} className="text-yellow-400" />
              </motion.div>
            </motion.div>
          </div>
          <h1 className="text-5xl font-bold mb-2 tracking-tight font-display bg-gradient-to-b from-white to-blue-300 bg-clip-text text-transparent">
            WordQuest
            <span className="block text-xl mt-1 text-blue-400/80 tracking-[0.2em] uppercase font-sans font-black">Galactic Vocabulary</span>
          </h1>
          
          <div className="relative mb-8 max-w-xs mx-auto">
            <button
              onClick={() => setIsBankMenuOpen(!isBankMenuOpen)}
              className="w-full flex items-center justify-between bg-white/5 hover:bg-white/10 text-blue-300 px-4 py-3 rounded-xl border border-white/10 backdrop-blur-md transition-all group"
            >
              <div className="flex items-center gap-3">
                <div className="bg-blue-500/20 p-1.5 rounded-lg group-hover:bg-blue-500/30 transition-colors">
                  <Orbit size={16} className="text-blue-400" />
                </div>
                <div className="text-left">
                  <p className="text-[10px] uppercase tracking-[0.2em] font-black opacity-50 leading-none mb-1">Sector</p>
                  <p className="text-sm font-bold text-white leading-none">{currentBank.name}</p>
                </div>
              </div>
              <ChevronDown size={18} className={`transition-transform duration-300 ${isBankMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
              {isBankMenuOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-40" 
                    onClick={() => setIsBankMenuOpen(false)} 
                  />
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute top-full left-0 right-0 mt-2 z-50 bg-slate-900/90 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl shadow-black/50"
                  >
                    <div className="p-2 grid grid-cols-1 gap-1">
                      {ALL_WORD_BANKS.map(bank => (
                        <button
                          key={bank.id}
                          onClick={() => {
                            setSelectedBankId(bank.id);
                            setIsBankMenuOpen(false);
                          }}
                          className={`flex items-center justify-between px-4 py-3 rounded-xl transition-all ${
                            selectedBankId === bank.id 
                              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' 
                              : 'text-blue-200/70 hover:bg-white/5 hover:text-white'
                          }`}
                        >
                          <span className="text-sm font-bold">{bank.name}</span>
                          {selectedBankId === bank.id && (
                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]" />
                          )}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          <p className="text-blue-200 text-lg mb-8 max-w-md mx-auto">
            Explore the Word Planets! Master your vocabulary through galactic missions.
          </p>
          
          <div className="mb-6 flex flex-col items-center">
            <div className={`text-xs font-bold uppercase tracking-[0.3em] ${getRank().color} mb-1`}>
              Current Rank
            </div>
            <div className="flex items-center gap-2 bg-white/5 px-4 py-2 rounded-full border border-white/10">
              <span className="text-xl">{getRank().icon}</span>
              <span className="text-lg font-bold text-white font-display">{getRank().name}</span>
            </div>
            <div className="mt-2 text-blue-300 text-xs font-bold uppercase tracking-widest">
              Missions Completed: <span className="text-white">{missionsFinished}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-12">
            <div className="glass-card p-4 flex flex-col items-center gap-2 border-green-500/20">
              <Trophy className="text-green-400" size={24} />
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-widest text-green-300 font-bold">Mastered</p>
                <p className="text-xl font-mono font-bold text-white">{totalStats.mastered}</p>
              </div>
            </div>
            <div className="glass-card p-4 flex flex-col items-center gap-2 border-blue-500/20">
              <Star className="text-blue-400" size={24} />
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-widest text-blue-300 font-bold">Familiar</p>
                <p className="text-xl font-mono font-bold text-white">{totalStats.familiar}</p>
              </div>
            </div>
            <div className="glass-card p-4 flex flex-col items-center gap-2 border-purple-500/20">
              <Orbit className="text-purple-400" size={24} />
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-widest text-purple-300 font-bold">Learning</p>
                <p className="text-xl font-mono font-bold text-white">{totalStats.unfamiliar}</p>
              </div>
            </div>
            <div className="glass-card p-4 flex flex-col items-center gap-2 border-orange-500/20">
              <Rocket className="text-orange-400" size={24} />
              <div className="text-center">
                <p className="text-[9px] uppercase tracking-widest text-orange-300 font-bold">Left</p>
                <p className="text-xl font-mono font-bold text-white">
                  {Math.max(0, currentBank.words.length - totalStats.mastered)}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={startNewRound}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-6 px-8 rounded-2xl text-xl transition-all transform hover:scale-105 shadow-lg shadow-blue-500/20 flex flex-col items-center gap-3"
            >
              <Rocket size={24} />
              Today's Mission
            </button>
            <button
              onClick={() => setView('browse')}
              className="bg-white/5 hover:bg-white/10 text-white font-bold py-6 px-8 rounded-2xl text-xl transition-all transform hover:scale-105 border border-white/10 flex flex-col items-center gap-3"
            >
              <BookOpen size={24} className="text-purple-400" />
              Word Library
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (view === 'browse') {
    return (
      <div className="space-bg flex flex-col p-6">
        <div className="stars" />
        <div className="z-30 flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <button 
              onClick={exitToHome}
              className="flex items-center gap-2 text-blue-300 hover:text-white transition-colors bg-white/5 px-4 py-2 rounded-xl border border-white/10"
            >
              <ArrowLeft size={20} />
              <span className="hidden sm:inline">Back</span>
            </button>
            <h2 className="text-2xl font-bold font-display text-white">Library</h2>
          </div>

          <div className="relative w-full sm:w-64">
            <button
              onClick={() => setIsBankMenuOpen(!isBankMenuOpen)}
              className="w-full flex items-center justify-between bg-white/5 hover:bg-white/10 text-blue-300 px-4 py-2 rounded-xl border border-white/10 backdrop-blur-md transition-all group"
            >
              <div className="flex items-center gap-3">
                <Orbit size={16} className="text-blue-400" />
                <span className="text-sm font-bold text-white truncate max-w-[120px]">{currentBank.name}</span>
              </div>
              <ChevronDown size={16} className={`transition-transform duration-300 ${isBankMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence>
              {isBankMenuOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-40" 
                    onClick={() => setIsBankMenuOpen(false)} 
                  />
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute top-full left-0 right-0 mt-2 z-50 bg-slate-900/90 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl shadow-black/50"
                  >
                    <div className="p-2 grid grid-cols-1 gap-1">
                      {ALL_WORD_BANKS.map(bank => (
                        <button
                          key={bank.id}
                          onClick={() => {
                            setSelectedBankId(bank.id);
                            setIsBankMenuOpen(false);
                          }}
                          className={`flex items-center justify-between px-4 py-2 rounded-xl transition-all ${
                            selectedBankId === bank.id 
                              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' 
                              : 'text-blue-200/70 hover:bg-white/5 hover:text-white'
                          }`}
                        >
                          <span className="text-xs font-bold">{bank.name}</span>
                          {selectedBankId === bank.id && (
                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]" />
                          )}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="z-10 mb-8 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40" size={20} />
          <input 
            type="text"
            placeholder="Search words or definitions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            inputMode="text"
          />
        </div>

        <div className="z-10 flex-1 overflow-y-auto pr-2 custom-scrollbar">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredWords.map((word) => {
              const status = wordStatus[word.id] || 'new';
              const statusColors = {
                mastered: 'border-l-green-500 text-green-400 bg-green-500/5',
                familiar: 'border-l-blue-500 text-blue-400 bg-blue-500/5',
                unfamiliar: 'border-l-purple-500 text-purple-400 bg-purple-500/5',
                new: 'border-l-gray-500 text-gray-400 bg-gray-500/5'
              };

              return (
                <motion.div 
                  key={word.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`glass-card p-4 border-l-4 ${statusColors[status]} flex flex-col h-full`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-bold text-white leading-tight">{word.word}</h3>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          speakWord(word.word);
                        }}
                        className="text-blue-400 hover:text-blue-300 transition-colors p-1 rounded-full hover:bg-white/5"
                        title="Listen"
                      >
                        <Volume2 size={16} />
                      </button>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[8px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded bg-white/10">
                        {status}
                      </span>
                      <button
                        onClick={() => {
                          setWordStatus(prev => ({
                            ...prev,
                            [word.id]: status === 'mastered' ? 'new' : 'mastered'
                          }));
                        }}
                        className={`text-[9px] font-bold uppercase tracking-tighter px-2 py-1 rounded-md transition-all ${
                          status === 'mastered'
                            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                            : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        }`}
                      >
                        {status === 'mastered' ? 'Unmark Mastered' : 'Mark Mastered'}
                      </button>
                    </div>
                  </div>
                  <p className="text-blue-200 text-sm leading-relaxed mb-3 flex-grow">
                    {word.definition}
                  </p>
                  {word.example && (
                    <div className="mt-auto pt-3 border-t border-white/5">
                      <p className="text-xs italic text-blue-300/70 line-clamp-2">
                        "{word.example}"
                      </p>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
          {filteredWords.length === 0 && (
            <div className="text-center py-20 text-white/40">
              <p className="text-xl">No words found in this sector...</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (gameState.isFinished) {
    return (
      <div className="space-bg flex flex-col items-center justify-center p-6 text-center">
        <div className="stars" />
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="glass-card p-8 max-w-lg w-full z-10"
        >
          <div className="mb-6">
            <Trophy size={80} className="text-yellow-400 mx-auto mb-4" />
            <h2 className="text-3xl font-bold mb-2 font-display">Mission Complete!</h2>
            <p className="text-blue-200">You've mastered this sector of the galaxy.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div className="space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-blue-300 text-left mb-2">Session Stats</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Trophy size={16} className="text-green-400" />
                    <span className="text-sm text-white">Mastered</span>
                  </div>
                  <span className="font-mono font-bold text-green-400">+{gameState.sessionStats.mastered}</span>
                </div>
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Star size={16} className="text-blue-400" />
                    <span className="text-sm text-white">Familiar</span>
                  </div>
                  <span className="font-mono font-bold text-blue-400">+{gameState.sessionStats.familiar}</span>
                </div>
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Orbit size={16} className="text-purple-400" />
                    <span className="text-sm text-white">Learning</span>
                  </div>
                  <span className="font-mono font-bold text-purple-400">+{gameState.sessionStats.unfamiliar}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-blue-300 text-left mb-2">Total Progress</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Trophy size={16} className="text-green-400" />
                    <span className="text-sm text-white">Total Mastered</span>
                  </div>
                  <span className="font-mono font-bold text-white">{totalStats.mastered}</span>
                </div>
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Star size={16} className="text-blue-400" />
                    <span className="text-sm text-white">Total Familiar</span>
                  </div>
                  <span className="font-mono font-bold text-white">{totalStats.familiar}</span>
                </div>
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Orbit size={16} className="text-purple-400" />
                    <span className="text-sm text-white">Total Learning</span>
                  </div>
                  <span className="font-mono font-bold text-white">{totalStats.unfamiliar}</span>
                </div>
                <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2">
                    <Rocket size={16} className="text-orange-400" />
                    <span className="text-sm text-white">Words Left</span>
                  </div>
                  <span className="font-mono font-bold text-white">
                    {Math.max(0, currentBank.words.length - totalStats.mastered)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={exitToHome}
              className="flex-1 bg-white/5 hover:bg-white/10 text-white font-bold py-4 rounded-xl transition-all border border-white/10"
            >
              Home Base
            </button>
            <button
              onClick={startNewRound}
              className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
            >
              <Rocket size={20} />
              Next Mission
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="space-bg flex flex-col p-6 overflow-hidden">
      <div className="stars" />
      
      {/* Header */}
      <div className="z-10 flex justify-between items-center mb-8">
        <button 
          onClick={exitToHome}
          className="flex items-center gap-2 text-blue-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="text-xs font-bold uppercase tracking-widest">Abort</span>
        </button>
        <div className="flex items-center gap-2">
          <Orbit className="text-purple-400" size={24} />
          <span className="font-display font-medium text-sm tracking-widest uppercase text-blue-300">
            Planet {gameState.currentIndex + 1} / {gameState.currentRoundWords.length}
          </span>
        </div>
        <div className="flex items-center gap-1 text-yellow-400">
          <Star size={16} fill="currentColor" />
          <span className="font-mono font-bold">{gameState.score}</span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col justify-center z-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentWord?.id}
            initial={{ x: 50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -50, opacity: 0 }}
            className="glass-card p-8 mb-8 relative overflow-hidden"
          >
            {/* Feedback Overlay */}
            <AnimatePresence>
              {gameState.feedback && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className={`absolute inset-0 z-20 flex items-center justify-center backdrop-blur-sm ${
                    gameState.feedback === 'correct' ? 'bg-green-500/40' : 'bg-red-500/20'
                  }`}
                >
                  {gameState.feedback === 'correct' ? (
                    <div className="text-center px-6">
                      <CheckCircle2 size={64} className="text-green-400 mx-auto mb-2" />
                      <p className="text-green-400 font-bold text-xl uppercase tracking-widest mb-4">Correct!</p>
                      {currentWord.example && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="bg-black/20 p-4 rounded-xl border border-white/10 italic text-white text-lg max-w-md"
                        >
                          "{currentWord.example}"
                        </motion.div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center">
                      {gameState.hintLevel === 3 ? (
                        <div className="text-center px-6">
                          <Lightbulb size={64} className="text-purple-400 mx-auto mb-2" />
                          <p className="text-purple-400 font-bold text-xl uppercase tracking-widest mb-2">Memorize It</p>
                          <p className="text-white/80 mb-4">The word was: <span className="font-bold text-white underline">{currentWord.word}</span></p>
                          {currentWord.example && (
                            <motion.div 
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="bg-black/20 p-4 rounded-xl border border-white/10 italic text-white text-lg max-w-md mx-auto"
                            >
                              "{currentWord.example}"
                            </motion.div>
                          )}
                        </div>
                      ) : (
                        <>
                          <XCircle size={64} className="text-red-400 mx-auto mb-2" />
                          <p className="text-red-400 font-bold text-xl uppercase tracking-widest">Try Again</p>
                          <p className="text-white/60 mt-2">Hint level increased!</p>
                        </>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mb-6">
              <h3 className="text-blue-300 text-xs font-bold uppercase tracking-widest mb-2">Definition</h3>
              <p className="text-xl md:text-2xl font-medium leading-relaxed">
                "{currentWord?.definition}"
              </p>
            </div>

            <div className="space-y-4">
              <AnimatePresence>
                {gameState.showHint && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-4 overflow-hidden"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-blue-400 font-mono font-bold text-xl tracking-[0.3em] bg-blue-500/10 py-3 px-4 rounded-xl border border-blue-500/20 text-center">
                        {getHintText()}
                      </div>
                      {gameState.hintLevel === 3 && (
                        <button
                          onClick={() => speakWord(currentWord.word)}
                          className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 p-3 rounded-xl border border-blue-500/30 transition-all"
                          title="Listen to pronunciation"
                        >
                          <Volume2 size={24} />
                        </button>
                      )}
                    </div>
                    {gameState.hintLevel === 3 && currentWord.example && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white/5 p-4 rounded-xl border border-white/10 italic text-blue-200 text-lg"
                      >
                        "{currentWord.example}"
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="relative">
                <input
                  type="text"
                  value={gameState.userInput}
                  onChange={(e) => setGameState(prev => ({ ...prev, userInput: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
                  placeholder="Type the word..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-4 px-6 text-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  autoFocus
                  disabled={!!gameState.feedback}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  onPaste={(e) => e.preventDefault()}
                  // Disable native voice input/dictation where possible
                  inputMode="text"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleHint}
                  disabled={gameState.hintLevel === 3 || !!gameState.feedback}
                  className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-blue-300 py-3 rounded-xl flex items-center justify-center gap-2 transition-all border border-white/5"
                >
                  <Lightbulb size={18} />
                  {gameState.hintLevel === 0 ? 'Tip' : `Tip ${gameState.hintLevel}/3`}
                </button>
                <button
                  onClick={skipWord}
                  disabled={!!gameState.feedback}
                  className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-orange-300 py-3 rounded-xl flex items-center justify-center gap-2 transition-all border border-white/5"
                >
                  <RotateCcw size={18} />
                  Skip
                </button>
                <button
                  onClick={handleCheck}
                  disabled={!gameState.userInput.trim() || !!gameState.feedback}
                  className={`flex-[2] ${gameState.hintLevel === 3 ? 'bg-purple-600 hover:bg-purple-500' : 'bg-blue-600 hover:bg-blue-500'} disabled:bg-blue-800 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg`}
                >
                  {gameState.hintLevel === 3 ? 'Got it' : 'Check'}
                  <ChevronRight size={20} />
                </button>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer Progress */}
      <div className="z-10 mt-auto pt-6">
        <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden">
          <motion.div 
            className="bg-blue-500 h-full"
            initial={{ width: 0 }}
            animate={{ width: `${(gameState.currentIndex / gameState.currentRoundWords.length) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
