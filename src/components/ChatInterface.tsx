import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Mic,
  MicOff,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Info,
  MicVocal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SuggestionChips } from "@/components/SuggestionChips";
import { ChatMessage } from "@/components/ChatMessage";
import { useLanguage } from "@/components/LanguageProvider";
import { useIsMobile } from "@/hooks/use-mobile";
import { AudioWaveform } from "@/components/AudioWaveform";
import apiService from "@/lib/api";
import { EmptyStateScreen } from "@/components/EmptyStateScreen";
import { detectIndianLanguage } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import AutoResizeTextarea from "@/components/AutoResizeTextarea";
import { v4 as uuidv4 } from "uuid";
import { toast } from "@/hooks/use-toast";
import {
  startTelemetry,
  logQuestionEvent,
  logResponseEvent,
  endTelemetry,
  endTelemetryWithWait,
  logFeedbackEvent,
  logErrorEvent,
  markAnswerRendered,
  initChatApiPerformanceObserver,
} from "@/lib/telemetry";
// Import audio utilities
import {
  setupAudioVisualization,
  setupAudioRecording,
  stopRecording,
} from "@/lib/audio-utils";

// import { useKeycloak } from "@react-keycloak/web";
import { cn } from "@/lib/utils";
import { useTts } from "@/hooks/use-tts";
import { FeedbackForm } from "@/components/FeedbackForm";
import { useAuth } from "@/contexts/AuthContext";
import VoiceAssistantInline from "@/components/VoiceAssistantInline";
import { markServerRequestStart } from "@/lib/telemetry";

interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  isFeedbackMessage?: boolean;
  isLoading?: boolean;
  isStreaming?: boolean;
  questionId?: string;
  questionText?: string;
  isErrorMessage?: boolean;
  errorTranslationKey?: string;
  retryAttempt?: number;
  maxRetryAttempts?: number;
  canRetry?: boolean;
  originalUserMessage?: string;
  retryClickCount?: number;
}

interface ChatResponse {
  response: string;
  status: string;
}

interface TranscriptionResponse {
  text: string;
  lang_code: string;
  status: string;
}

interface SuggestionItem {
  question: string;
}

// Audio interfaces
interface Window {
  webkitAudioContext: typeof AudioContext;
  currentAudioStream?: MediaStream | null;
  mediaRecorder?: MediaRecorder | null;
}

export function ChatInterface() {
  const { language, t } = useLanguage();
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [inputPositioned, setInputPositioned] = useState(true);
  // Auto-resize now handled by AutoResizeTextarea; no explicit rows state
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const initialSuggestionRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [maxRecordingDuration, setMaxRecordingDuration] = useState(20000); // 8 seconds in milliseconds
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isMessageLoading, setIsMessageLoading] = useState(false); // Track if a message is currently loading
  const [showInlineVoice, setShowInlineVoice] = useState(false);

  // Suggestion related states
  const [displayedSuggestion, setDisplayedSuggestion] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [currentSuggestion, setCurrentSuggestion] = useState("");
  const [typingIndex, setTypingIndex] = useState(0);
  const [isAiTyping, setIsAiTyping] = useState(false);
  const [allSuggestions, setAllSuggestions] = useState<string[]>([]);
  const [currentSuggestionIndex, setCurrentSuggestionIndex] = useState(0);

  // Suggestion refresh interval configuration (tweakable)
  const [suggestionRefreshInterval, setSuggestionRefreshInterval] =
    useState(10000); // 10 seconds in milliseconds
  const [suggestionRefreshCount, setSuggestionRefreshCount] = useState(0);
  const [maxSuggestionRefreshes, setMaxSuggestionRefreshes] = useState(5);
  const suggestionRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Audio related states and refs
  const [audioLevel, setAudioLevel] = useState(0.5);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioDataRef = useRef<Uint8Array | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  // Feedback related states
  const feedbackOptions = t("feedbackOptions") as string[];
  const [showFeedbackDialog, setShowFeedbackDialog] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [dislikedMessageId, setDislikedMessageId] = useState<string | null>(
    null,
  );
  const [likedMessageId, setLikedMessageId] = useState<string | null>(null);
  const [feedbackQuestionText, setFeedbackQuestionText] = useState("");
  const [feedbackResponseText, setFeedbackResponseText] = useState("");
  const [isFeedbackRecording, setIsFeedbackRecording] = useState(false);
  const feedbackRecordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const feedbackAudioAnalyserRef = useRef<AnalyserNode | null>(null);
  const feedbackAudioDataRef = useRef<Uint8Array | null>(null);
  const feedbackAnimationFrameRef = useRef<number | null>(null);
  const feedbackMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const feedbackAudioStreamRef = useRef<MediaStream | null>(null);
  const [feedbackAudioLevel, setFeedbackAudioLevel] = useState(0.5);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputContainerRef = useRef<HTMLDivElement>(null);

  const { stopAudio, playAudio } = useTts();

  // Add this effect to update the input height CSS variable
  useEffect(() => {
    const updateInputHeight = () => {
      if (inputContainerRef.current) {
        const inputHeight = inputContainerRef.current.offsetHeight;
        document.documentElement.style.setProperty(
          "--input-height",
          `${inputHeight}px`,
        );
      }
    };

    // Call initially and set up resize observer
    updateInputHeight();

    const resizeObserver = new ResizeObserver(updateInputHeight);
    if (inputContainerRef.current) {
      resizeObserver.observe(inputContainerRef.current);
    }

    window.addEventListener("resize", updateInputHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateInputHeight);
    };
  }, []);

  // Helper functions for managing messages
  const addMessage = (text: string, isUser: boolean, options = {}): string => {
    const id = `${isUser ? "user" : "bot"}-${uuidv4()}`;
    const newMessage: Message = {
      id,
      text,
      isUser,
      timestamp: new Date(),
      ...options,
    };

    setMessages((prev) => [...prev, newMessage]);
    return id;
  };

  const updateMessage = (id: string, updates: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)),
    );
  };

  // Create a session ID
  const createSession = useCallback(() => {
    const newSessionId = uuidv4();
    setSessionId(newSessionId);
    apiService.setSessionId(newSessionId);
    startTelemetry(newSessionId, {
      preferred_username: user?.username || "default-username",
      email: user?.email || "default-email",
    });
    return newSessionId;
  }, [user]);

  // Helper function to update suggestion refresh interval (tweakable)
  const updateSuggestionRefreshInterval = (intervalMs: number) => {
    setSuggestionRefreshInterval(intervalMs);
  };

  // Helper function to update max suggestion refreshes (tweakable)
  const updateMaxSuggestionRefreshes = (maxRefreshes: number) => {
    setMaxSuggestionRefreshes(maxRefreshes);
  };

  // Function to start suggestion refresh cycle
  const startSuggestionRefreshCycle = (currentSession: string) => {
    // Clear any existing timer
    if (suggestionRefreshTimerRef.current) {
      clearInterval(suggestionRefreshTimerRef.current);
    }

    // Reset counter and call immediately (first call)
    setSuggestionRefreshCount(1);
    // fetchSuggestions(currentSession);

    // Start the interval for remaining calls if we haven't reached max
    if (maxSuggestionRefreshes > 1) {
      suggestionRefreshTimerRef.current = setInterval(() => {
        setSuggestionRefreshCount((prevCount) => {
          const newCount = prevCount + 1;

          // if (newCount <= maxSuggestionRefreshes) {
          // fetchSuggestions(currentSession);
          // }

          // Stop the timer if we've reached the max count
          if (
            newCount >= maxSuggestionRefreshes &&
            suggestionRefreshTimerRef.current
          ) {
            clearInterval(suggestionRefreshTimerRef.current);
            suggestionRefreshTimerRef.current = null;
          }

          return newCount;
        });
      }, suggestionRefreshInterval);
    }
  };

  // Get user location
  const getUserLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const locationData = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          };
          apiService.setLocationData(locationData);
        },
        (error) => {
          console.log("Unable to retrieve location:", error);

          // Show toast notification based on the error
          // switch(error.code) {
          //   case error.PERMISSION_DENIED:
          //     toast({
          //       title: t("toast.locationPermissionDenied.title") as string,
          //       description: t("toast.locationPermissionDenied.description") as string,
          //       variant: "yellow",
          //     });
          //     break;
          //   case error.POSITION_UNAVAILABLE:
          //     toast({
          //       title: t("toast.locationUnavailable.title") as string,
          //       description: t("toast.locationUnavailable.description") as string,
          //       variant: "yellow",
          //     });
          //     break;
          //   case error.TIMEOUT:
          //     toast({
          //       title: t("toast.locationTimeout.title") as string,
          //       description: t("toast.locationTimeout.description") as string,
          //       variant: "yellow",
          //     });
          //     break;
          //   default:
          //     toast({
          //       title: t("toast.locationError.title") as string,
          //       description: t("toast.locationError.description") as string,
          //       variant: "yellow",
          //     });
          // }
        },
      );
    } else {
      // toast({
      //   title: t("toast.locationNotSupported.title") as string,
      //   description: t("toast.locationNotSupported.description") as string,
      //   variant: "yellow",
      // });
    }
  };

  // Fetch suggestions for the chat - only called after a chat response
  const fetchSuggestions = async (currentSession = sessionId) => {
    // Use the current sessionId or create a new one if needed
    const sessionToUse = currentSession || createSession();

    try {
      const suggestions = (await apiService.getSuggestions(
        sessionToUse,
        language,
      )) as SuggestionItem[];
      if (suggestions && suggestions.length > 0) {
        setNewSuggestion(suggestions);
      }
    } catch (error) {
      console.error("Failed to fetch suggestions:", error);
      // Set a fallback suggestion if API fails
      // const fallbackSuggestions = [
      //   "What is the weather forecast for tomorrow?",
      //   "Tell me about PM Kisan Yojana",
      //   "What is the current market price of wheat?",
      //   "How to prevent crop diseases during monsoon?",
      // ];
      // setNewSuggestion({ question: fallbackSuggestions[Math.floor(Math.random() * fallbackSuggestions.length)] });
    }
  };

  const setNewSuggestion = (
    suggestions: SuggestionItem[] | { question: string },
  ) => {
    let suggestionsList: string[];

    if (Array.isArray(suggestions)) {
      suggestionsList = suggestions.map((s) => s.question);
    } else {
      suggestionsList = [suggestions.question];
    }

    setAllSuggestions(suggestionsList);
    setCurrentSuggestion(suggestionsList[0]);
    setCurrentSuggestionIndex(0);
  };

  // Effect to cycle through suggestions every 10 seconds
  useEffect(() => {
    if (allSuggestions.length === 0) return;

    const cycleTimer = setInterval(() => {
      setCurrentSuggestionIndex((prevIndex) => {
        const nextIndex = (prevIndex + 1) % allSuggestions.length;
        setCurrentSuggestion(allSuggestions[nextIndex]);
        return nextIndex;
      });
    }, 10000); // 10 seconds

    return () => clearInterval(cycleTimer);
  }, [allSuggestions]);

  // Cleanup suggestion refresh timer on unmount
  useEffect(() => {
    // initChatApiPerformanceObserver();
    return () => {
      if (suggestionRefreshTimerRef.current) {
        clearInterval(suggestionRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const lastAnswer = [...messages]
      .reverse()
      .find(
        (m) => !m.isUser && m.questionId && m.text && m.isStreaming === false,
      );

    if (lastAnswer) {
      requestAnimationFrame(() => {
        markAnswerRendered(lastAnswer.questionId!, () => {
          // Call logResponseEvent after paint timing is recorded
          const message = messages.find(
            (m) => m.questionId === lastAnswer.questionId,
          );
          if (message && message.questionText) {
            logResponseEvent(
              lastAnswer.questionId!,
              sessionId,
              message.questionText,
              lastAnswer.text,
            );
          }
          // Just record the paint timing, don't log response event here anymore
          console.log("Paint timing recorded for", lastAnswer.questionId);
        });
      });
    }
  }, [messages, sessionId]);

  // Handle text message sending
  const handleSendMessage = async () => {
    if (inputValue.trim() === "" || isMessageLoading) return;

    if (!inputPositioned) {
      setInputPositioned(true);
    }
    scrollToBottomOfMessages();
    // Add user message
    const userMessageId = addMessage(inputValue, true);

    // Add loading message for bot
    const loadingMessageId = addMessage("", false, { isLoading: true });

    // Set message loading state
    setIsMessageLoading(true);

    // Clear input
    setInputValue("");

    try {
      await sendMessageToApi(inputValue, loadingMessageId);
    } catch (error) {
      console.error("Error sending message:", error);
      updateMessage(loadingMessageId, {
        text: "",
        isLoading: false,
        isErrorMessage: true,
        errorTranslationKey: "toast.apiError.description",
      });
    } finally {
      // Reset loading state when done
      setIsMessageLoading(false);
    }
  };

  // When an error occurs, ensure the UI updates completely
  const forceUIRefresh = () => {
    // Force a style update to trigger reflow
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.overflow = "hidden";
      setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.style.overflow = "";
        }
        scrollToBottomOfMessages();
      }, 50);
    }
  };

  // Core API communication function
  const sendMessageToApi = async (
    text: string,
    loadingMessageId: string,
    options?: { autoTts?: boolean },
  ): Promise<{ messageId: string; finalText: string | null }> => {
    // Determine target and source language
    const targetLang = language;
    let sourceLang = "en"; // Default source language
    const detectedLanguage = detectIndianLanguage(text);
    sourceLang = detectedLanguage.code;
    console.log(sourceLang);
    const questionId = uuidv4();
    markServerRequestStart(questionId);
    await startTelemetry(sessionId, {
      preferred_username: user?.username || "default-username",
      email: user?.email || "default-email",
    });
    logQuestionEvent(questionId, sessionId, text);
    endTelemetry();
    // Use the current sessionId or create a new UUID if needed
    const currentSession = sessionId || createSession();

    // Handle streaming response
    let streamingText = "";
    let retryAttemptCount = 0;
    const maxRetries = apiService.getRetryConfig().maxAttempts;

    try {
      // Set streaming state to true when we begin receiving message chunks
      updateMessage(loadingMessageId, {
        isLoading: false,
        isStreaming: true,
        questionId,
        questionText: text,
      });

      const response = (await apiService.sendUserQuery(
        text,
        currentSession,
        sourceLang,
        targetLang,
        (chunk) => {
          // Update the message with the streaming text
          scrollToBottom();
          streamingText += chunk;
          updateMessage(loadingMessageId, {
            text: streamingText,
            isStreaming: true,
            questionId,
            questionText: text,
          });
        },
        (attempt, error) => {
          // Retry callback
          retryAttemptCount = attempt;
          console.log(`Retry attempt ${attempt}/${maxRetries}:`, error.message);

          // Update message to show retry status
          const retryMessage = t("toast.retrying.description") as string;
          updateMessage(loadingMessageId, {
            text: retryMessage,
            isLoading: true,
            isStreaming: false,
            retryAttempt: attempt,
            maxRetryAttempts: maxRetries,
          });
        },
      )) as ChatResponse;

      if (response && response.response) {
        // Final update with complete response - set streaming to false
        updateMessage(loadingMessageId, {
          text: response.response,
          isStreaming: false,
          questionId,
          questionText: text,
          canRetry: false,
        });
        await startTelemetry(sessionId, {
          preferred_username: user?.username || "default-username",
          email: user?.email || "default-email",
        });
        // logResponseEvent will be called from useEffect callback after paint timing is recorded
        // ← ADD THIS LINE:
        // logResponseEvent(questionId, sessionId, text, response.response);
        await endTelemetryWithWait();
        delete window.__RESPONSE_TIMERS__[questionId];
        if (options?.autoTts) {
          // Auto play TTS for the final response
          playAudio(response.response, loadingMessageId);
        }
        // Start suggestion refresh cycle after the message is sent
        startSuggestionRefreshCycle(currentSession);
        return { messageId: loadingMessageId, finalText: response.response };
      } else {
        // Handle empty response
        updateMessage(loadingMessageId, {
          text: "",
          isErrorMessage: true,
          isStreaming: false,
          questionId,
          questionText: text,
          errorTranslationKey: "toast.apiEmptyResponse.description",
          isLoading: false,
          canRetry: true,
          originalUserMessage: text,
        });
        await startTelemetry(sessionId, {
          preferred_username: user?.username || "default-username",
          email: user?.email || "default-email",
        });
        logErrorEvent(questionId, sessionId, "Empty response from API");
        await endTelemetry();
        return { messageId: loadingMessageId, finalText: null };
      }
    } catch (error) {
      console.error("Error sending query to API:", error);
      // Handle error response with clear error message
      const errorMessage = t("toast.apiError.description") as string;
      updateMessage(loadingMessageId, {
        text: "",
        isLoading: false,
        isErrorMessage: true,
        errorTranslationKey: "toast.apiError.description",
        canRetry: true,
        originalUserMessage: text,
        retryAttempt: retryAttemptCount,
        maxRetryAttempts: maxRetries,
      });

      // Force UI refresh for error messages
      forceUIRefresh();

      await startTelemetry(sessionId, {
        preferred_username: user?.username || "default-username",
        email: user?.email || "default-email",
      });
      logErrorEvent(
        questionId,
        sessionId,
        "API error: " +
          (error instanceof Error ? error.message : String(error)),
      );
      await endTelemetry();
      return { messageId: loadingMessageId, finalText: null };
    }
  };

  // Inline voice assistant -> send voice transcription into chat
  const handleSendFromVoiceDialog = async (
    voiceText: string,
  ): Promise<{ botMessageId: string; responseText: string }> => {
    const userMessageId = addMessage(voiceText, true);
    const loadingMessageId = addMessage("", false, { isLoading: true });
    setIsMessageLoading(true);
    try {
      const result = await sendMessageToApi(voiceText, loadingMessageId);
      return {
        botMessageId: result.messageId,
        responseText: result.finalText || "",
      };
    } finally {
      setIsMessageLoading(false);
    }
  };

  // Handle manual retry for failed messages
  const handleRetry = async (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (!message || !message.originalUserMessage) return;

    // Increment retry click count
    const currentRetryClickCount = (message.retryClickCount || 0) + 1;

    // If this is the 3rd click (after 2 visible clicks), hide the button and don't retry
    if (currentRetryClickCount >= 3) {
      updateMessage(messageId, {
        canRetry: false,
        retryClickCount: currentRetryClickCount,
      });
      return;
    }

    // Update message to show retrying state and increment click count
    updateMessage(messageId, {
      isLoading: true,
      isErrorMessage: false,
      errorTranslationKey: undefined,
      canRetry: currentRetryClickCount < 2, // Hide button after 2nd click
      retryClickCount: currentRetryClickCount,
    });

    setIsMessageLoading(true);

    try {
      await sendMessageToApi(message.originalUserMessage, messageId);
    } catch (error) {
      console.error("Error retrying message:", error);
    } finally {
      setIsMessageLoading(false);
    }
  };

  // Audio recording functions
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await setIsRecording(true);

      // Store the stream in the ref
      audioStreamRef.current = stream;

      // Use the audio utility functions
      setupAudioVisualization(
        stream,
        audioAnalyserRef,
        audioDataRef,
        animationFrameRef,
        setAudioLevel,
      );

      setupAudioRecording(
        stream,
        mediaRecorderRef,
        (transcribedText: string) => {
          // Handle transcribed text callback
          setInputValue(
            (prevValue) => prevValue + (prevValue ? " " : "") + transcribedText,
          );
          setTimeout(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.style.height = "40px";
            const scrollHeight = textarea.scrollHeight;
            if (scrollHeight > 40) {
              textarea.style.height = `${Math.min(scrollHeight, 120)}px`;
            }
          }, 10);
        },
        sessionId,
        toast,
      );

      // Set timeout to stop recording after maxRecordingDuration
      recordingTimerRef.current = setTimeout(() => {
        stopRecording(
          setIsRecording,
          recordingTimerRef,
          animationFrameRef,
          mediaRecorderRef,
          audioStreamRef,
          audioAnalyserRef,
          audioDataRef,
        );
      }, maxRecordingDuration);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      toast({
        title: "Microphone permission required",
        description:
          "Please allow microphone access in your browser settings to record audio.",
        variant: "yellow",
      });
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording(
        setIsRecording,
        recordingTimerRef,
        animationFrameRef,
        mediaRecorderRef,
        audioStreamRef,
        audioAnalyserRef,
        audioDataRef,
      );
    } else {
      startRecording();
    }
  };

  // Feedback handling
  const handleDislike = (
    messageId: string,
    questionText: string,
    responseText: string,
  ) => {
    const message = messages.find((m) => m.id === messageId);
    if (!message) return;

    setDislikedMessageId(messageId);
    setFeedbackQuestionText(questionText);
    setFeedbackResponseText(responseText);
    setShowFeedbackDialog(true);
  };

  const handleLike = async (
    messageId: string,
    questionText: string,
    responseText: string,
  ) => {
    const message = messages.find((m) => m.id === messageId);
    if (!message) return;

    setLikedMessageId(messageId);
    setFeedbackQuestionText(questionText);
    setFeedbackResponseText(responseText);

    // Send telemetry for the like event
    await startTelemetry(sessionId, {
      preferred_username: user?.username || "default-username",
      email: user?.email || "default-email",
    });
    logFeedbackEvent(
      message.questionId || messageId,
      sessionId,
      "Liked the response",
      "like",
      message.questionText || "",
      message.text,
    );
    endTelemetry();

    // Send a generic feedback message
    toast({
      title: t("toast.feedbackThankYou.title") as string,
      description: t("toast.feedbackThankYou.description") as string,
    });
  };

  const submitFeedback = async () => {
    const message = messages.find((m) => m.id === dislikedMessageId);
    if (!message) return;

    toast({
      title: t("toast.feedbackSubmitted.title") as string,
      description: t("toast.feedbackSubmitted.description") as string,
    });

    await startTelemetry(sessionId, {
      preferred_username: user?.username || "default-username",
      email: user?.email || "default-email",
    });
    logFeedbackEvent(
      message.questionId || dislikedMessageId,
      sessionId,
      feedbackText,
      "dislike",
      message.questionText || "",
      message.text,
    );
    endTelemetry();
    setShowFeedbackDialog(false);
    setFeedbackText("");
    setDislikedMessageId(null);
    setFeedbackQuestionText("");
    setFeedbackResponseText("");
  };

  // UI interactions
  const handleSuggestionSelect = (suggestion: string) => {
    setInputValue(suggestion);
  };

  // Modify isNearBottom to handle scroll calculations better
  const isNearBottom = useCallback(() => {
    // Find the real scrollable element more reliably
    const findCurrentScrollElement = () => {
      if (viewportRef.current) return viewportRef.current;

      if (scrollContainerRef.current) {
        const viewport = scrollContainerRef.current.closest(
          "[data-radix-scroll-area-viewport]",
        );
        if (viewport) return viewport as HTMLDivElement;
      }

      return scrollContainerRef.current;
    };

    const scrollElement = findCurrentScrollElement();
    if (!scrollElement) {
      // console.log('No scroll element found in isNearBottom');
      return true; // Default to true if we can't find the container
    }

    const threshold = 80; // 50px from bottom threshold

    const scrollHeight = scrollElement.scrollHeight;
    const scrollTop = scrollElement.scrollTop;
    const clientHeight = scrollElement.clientHeight;
    const bottomPosition = scrollHeight - scrollTop - clientHeight;
    return bottomPosition < threshold;
  }, []);

  // Modify the scrollToBottom function to prevent unwanted scrolling when keyboard is open
  const scrollToBottom = useCallback(() => {
    // Don't auto-scroll when keyboard is open on mobile
    if (isMobile && isKeyboardVisible) return;

    const shouldScroll = isNearBottom();
    if (shouldScroll) {
      const scrollElement =
        viewportRef.current ||
        (scrollContainerRef.current?.closest(
          "[data-radix-scroll-area-viewport]",
        ) as HTMLDivElement) ||
        scrollContainerRef.current;

      if (scrollElement) {
        const bottomPosition =
          scrollElement.scrollHeight -
          scrollElement.scrollTop -
          scrollElement.clientHeight;

        // If exactly at bottom (within 1px), use instant scroll, otherwise smooth scroll
        const scrollBehavior = bottomPosition <= 1 ? "auto" : "smooth";
        messagesEndRef.current?.scrollIntoView({
          behavior: scrollBehavior as ScrollBehavior,
        });
      } else {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [isMobile, isKeyboardVisible, isNearBottom]);

  // Modify scrollToBottomOfMessages to respect keyboard state on mobile
  const scrollToBottomOfMessages = () => {
    // Don't force scroll when keyboard is open on mobile
    if (isMobile && isKeyboardVisible) return;

    // Use setTimeout to ensure DOM is updated
    setTimeout(() => {
      const scrollElement =
        viewportRef.current ||
        (scrollContainerRef.current?.closest(
          "[data-radix-scroll-area-viewport]",
        ) as HTMLDivElement) ||
        scrollContainerRef.current;

      if (scrollElement) {
        // Always scroll to bottom regardless of current position
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
      // Also use scrollIntoView as backup
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 500);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setInputValue(text);
  };

  // Start recording for feedback
  const startFeedbackRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await setIsFeedbackRecording(true);

      // Store the stream in the ref
      feedbackAudioStreamRef.current = stream;

      // Use the audio utility functions
      setupAudioVisualization(
        stream,
        feedbackAudioAnalyserRef,
        feedbackAudioDataRef,
        feedbackAnimationFrameRef,
        setFeedbackAudioLevel,
      );

      setupAudioRecording(
        stream,
        feedbackMediaRecorderRef,
        (transcribedText: string) => {
          // Handle transcribed text callback for feedback
          setFeedbackText(
            (prevValue) => prevValue + (prevValue ? " " : "") + transcribedText,
          );
        },
        sessionId,
        toast,
      );

      // Set timeout to stop recording after maxRecordingDuration
      feedbackRecordingTimerRef.current = setTimeout(() => {
        stopFeedbackRecording();
      }, maxRecordingDuration);
    } catch (err) {
      console.error("Error accessing microphone for feedback:", err);
      toast({
        title: "Microphone permission required",
        description:
          "Please allow microphone access in your browser settings to record feedback.",
        variant: "yellow",
      });
    }
  };

  const stopFeedbackRecording = () => {
    stopRecording(
      setIsFeedbackRecording,
      feedbackRecordingTimerRef,
      feedbackAnimationFrameRef,
      feedbackMediaRecorderRef,
      feedbackAudioStreamRef,
      feedbackAudioAnalyserRef,
      feedbackAudioDataRef,
    );
  };

  const toggleFeedbackRecording = () => {
    if (isFeedbackRecording) {
      stopFeedbackRecording();
    } else {
      startFeedbackRecording();
    }
  };

  // Effects
  useEffect(() => {
    // Initialize with a new session ID right away
    createSession();
  }, [createSession]);

  useEffect(() => {
    getUserLocation();
  }, []);

  useEffect(() => {
    // Don't auto-scroll when keyboard is open on mobile
    if (isMobile && isKeyboardVisible) return;

    // Always scroll to bottom when messages change
    scrollToBottom();
  }, [messages, isMobile, isKeyboardVisible, scrollToBottom]);

  // Remove the typing animation effect for suggestions
  useEffect(() => {
    if (!isTyping || !currentSuggestion) return;

    if (typingIndex >= currentSuggestion.length) {
      setIsTyping(false);
      return;
    }

    const typingTimeout = setTimeout(() => {
      setDisplayedSuggestion(
        (prev) => prev + currentSuggestion.charAt(typingIndex),
      );
      setTypingIndex((prev) => prev + 1);
    }, 50);

    return () => clearTimeout(typingTimeout);
  }, [isTyping, typingIndex, currentSuggestion]);

  // Auto-resize handled by AutoResizeTextarea component

  // Add a keyboard detection effect
  useEffect(() => {
    if (!isMobile) return;

    // Helper function to handle keyboard detection
    const handleKeyboardAppearance = () => {
      // On iOS, we can detect keyboard appearance by window height changes
      const visualViewport = window.visualViewport;
      if (!visualViewport) return;

      // Track keyboard visibility by comparing visual viewport height to window inner height
      const handleVisualViewportChange = () => {
        const kbHeight = Math.max(
          0,
          window.innerHeight - visualViewport.height,
        );
        document.documentElement.style.setProperty(
          "--keyboard-offset",
          `${kbHeight}px`,
        );

        setKeyboardHeight(kbHeight);

        // Only change keyboard visibility state if significant height change
        if (kbHeight > 100 && !isKeyboardVisible) {
          setIsKeyboardVisible(true);

          // Make sure input sits directly on top of keyboard with no gap
          if (inputContainerRef.current) {
            // Remove the bottom property since we'll use transform in the component
            inputContainerRef.current.style.bottom = "0";
          }
        } else if (kbHeight <= 100 && isKeyboardVisible) {
          setIsKeyboardVisible(false);

          // Keyboard is hidden
          if (inputContainerRef.current) {
            inputContainerRef.current.style.bottom = "0";
          }
        }
      };

      visualViewport.addEventListener("resize", handleVisualViewportChange);
      return () =>
        visualViewport.removeEventListener(
          "resize",
          handleVisualViewportChange,
        );
    };

    const cleanup = handleKeyboardAppearance();
    return cleanup;
  }, [isMobile, isKeyboardVisible]);

  const handlePreviousSuggestion = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setCurrentSuggestionIndex((prevIndex) => {
      const newIndex =
        prevIndex > 0 ? prevIndex - 1 : allSuggestions.length - 1;
      setCurrentSuggestion(allSuggestions[newIndex]);
      return newIndex;
    });
  };

  const handleNextSuggestion = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setCurrentSuggestionIndex((prevIndex) => {
      const nextIndex = (prevIndex + 1) % allSuggestions.length;
      setCurrentSuggestion(allSuggestions[nextIndex]);
      return nextIndex;
    });
  };

  // Render a different input for mobile
  const renderMobileInput = () => {
    // Fix for iOS to ensure the input sticks to the keyboard
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    const adjustedHeight =
      isIOS && isKeyboardVisible ? keyboardHeight - 1 : keyboardHeight; // -1px to ensure visual contact on iOS

    return (
      <>
        <div
          className="fixed left-0 right-0 bottom-0 z-20 flex flex-col"
          style={{
            transform: isKeyboardVisible
              ? `translateY(-${adjustedHeight}px)`
              : "none",
            paddingBottom: isKeyboardVisible
              ? "0"
              : "env(safe-area-inset-bottom, 8px)",
          }}
        >
          <div className="mx-3 mb-2">
            <div
              className={cn(
                "flex items-center gap-2",
                !currentSuggestion && showInlineVoice ? "justify-end" : "",
              )}
            >
              {currentSuggestion && (
                <div
                  className="flex-1 bg-background/95 p-3 backdrop-blur rounded-lg text-sm cursor-pointer border border-primary hover:border hover:border-primary transition-all"
                  onClick={() => handleSuggestionSelect(currentSuggestion)}
                >
                  <div className="flex items-center justify-between">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full"
                      onClick={handlePreviousSuggestion}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <div className="font-medium">{currentSuggestion}</div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full"
                      onClick={handleNextSuggestion}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              {showInlineVoice && (
                <VoiceAssistantInline
                  onSendVoice={handleSendFromVoiceDialog}
                  className="flex-shrink-0"
                  onClose={() => setShowInlineVoice(false)}
                  autoStart={!currentSuggestion}
                />
              )}
            </div>
          </div>
          <div
            ref={inputContainerRef}
            className={cn(
              "bg-background border-t border-border transition-all duration-200",
              isKeyboardVisible ? "shadow-lg border-b-0" : "",
            )}
          >
            <div className="p-3 relative">
              <div className="flex items-center gap-2 bg-background rounded-lg border border-border p-2">
                <AutoResizeTextarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyPress}
                  onFocus={() => {
                    // Ensure positioning gets updated on focus
                    if (window.visualViewport) {
                      const kbHeight = Math.max(
                        0,
                        window.innerHeight - window.visualViewport.height,
                      );
                      if (kbHeight > 100) {
                        setIsKeyboardVisible(true);
                        setKeyboardHeight(kbHeight);
                      }
                    }
                  }}
                  placeholder={t("inputPlaceholder") as string}
                  className="flex-1 transition-all duration-100"
                  style={{
                    paddingRight: "8px",
                    paddingLeft: "8px",
                    paddingTop: "6px",
                    paddingBottom: "6px",
                    fontSize: isMobile ? "16px" : "",
                  }}
                  disabled={isMessageLoading}
                  minRows={1}
                  maxRows={6}
                />
                <div className="flex flex-shrink-0 gap-2">
                  <Button
                    onClick={toggleRecording}
                    variant={isRecording ? "destructive" : "outline"}
                    size="icon"
                    className="rounded-full flex-shrink-0 h-9 w-9"
                    aria-label={
                      isRecording
                        ? (t("stopRecording") as string)
                        : (t("startRecording") as string)
                    }
                    disabled={isMessageLoading}
                  >
                    {isRecording ? (
                      <AudioWaveform
                        isActive={isRecording}
                        audioLevel={audioLevel}
                      />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </Button>
                  {/* Interactive mic button commented out */}
                  {/* <Button
                  onClick={() => setShowInlineVoice(true)}
                  variant="ghost"
                  size="icon"
                  className="rounded-full flex-shrink-0 h-9 w-9"
                  aria-label="AI Enhanced Voice"
                  disabled={isMessageLoading}
                >
                  <MicVocal className="h-4 w-4" />
                </Button> */}
                  <Button
                    onClick={handleSendMessage}
                    disabled={inputValue.trim() === "" || isMessageLoading}
                    variant="default"
                    size="icon"
                    className="rounded-full flex-shrink-0 h-9 w-9"
                    aria-label={t("send") as string}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="text-xs text-muted-foreground text-center mt-1 flex items-center justify-center">
                <Info className="h-3 w-3 mr-1 inline-block" />
                {(t("disclaimerText") as string) ||
                  "Bharat Vistaar is AI and can make mistakes. Please verify sources."}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  };

  // Update cleanup in useEffect to stop audio when component unmounts
  useEffect(() => {
    return () => {
      // No need to stop audio here as the AudioPlayer handles its own cleanup
    };
  }, []);

  return (
    <div className="flex flex-col h-full relative p-[0px!important]">
      {messages.length === 0 ? (
        <EmptyStateScreen setInputValue={setInputValue} />
      ) : (
        <ScrollArea className="flex-1 h-[calc(100vh-var(--header-height)-var(--input-height))]">
          <div
            ref={(el) => {
              scrollContainerRef.current = el;
              // Also set viewportRef to the parent scroll viewport
              if (el) {
                const viewport = el.closest(
                  "[data-radix-scroll-area-viewport]",
                ) as HTMLDivElement;
                if (viewport) viewportRef.current = viewport;
              }
            }}
            className={cn(
              isMobile
                ? isKeyboardVisible
                  ? "pb-24 md:pb-20"
                  : "pb-32 md:pb-20 mt-20"
                : "pb-24 md:pb-20",
              messages.length === 1 ? "min-h-[70vh]" : "", // Ensure single message has enough height
            )}
          >
            <div
              className={cn(
                "message-container",
                isMobile ? "space-y-4 px-2" : "space-y-4 px-4", // Increased spacing on mobile
              )}
            >
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message.text}
                  isUser={message.isUser}
                  timestamp={message.timestamp}
                  onDislike={
                    !message.isUser &&
                    !message.isLoading &&
                    !message.isFeedbackMessage
                      ? (questionText: string, responseText: string) =>
                          handleDislike(
                            message.id,
                            message.questionText || "",
                            message.text,
                          )
                      : undefined
                  }
                  onLike={
                    !message.isUser &&
                    !message.isLoading &&
                    !message.isFeedbackMessage
                      ? (questionText: string, responseText: string) =>
                          handleLike(
                            message.id,
                            message.questionText || "",
                            message.text,
                          )
                      : undefined
                  }
                  onRetry={
                    message.canRetry ? () => handleRetry(message.id) : undefined
                  }
                  messageId={message.id}
                  isLoading={message.isLoading}
                  isStreaming={message.isStreaming}
                  isFeedbackMessage={message.isFeedbackMessage}
                  questionText={message.questionText}
                  responseText={message.text}
                  isErrorMessage={message.isErrorMessage}
                  errorTranslationKey={message.errorTranslationKey}
                  retryClickCount={message.retryClickCount}
                />
              ))}
              <div ref={messagesEndRef} className="h-8" />
            </div>
          </div>
        </ScrollArea>
      )}

      {/* Render different input containers for mobile vs desktop */}
      {isMobile ? (
        renderMobileInput()
      ) : (
        <div className="fixed bottom-0 left-0 right-0 bg-background/95 supports-[backdrop-filter]:bg-background/0">
          <div className="border-border">
            <div className="p-4">
              <div className="relative max-w-2xl mx-auto">
                <div className="absolute -top-16 left-4 right-4 z-10">
                  <div
                    className={cn(
                      "flex items-center gap-2",
                      !currentSuggestion && showInlineVoice
                        ? "justify-end"
                        : "",
                    )}
                  >
                    {currentSuggestion && (
                      <div
                        className="flex-1 bg-background/95 p-3 backdrop-blur rounded-lg text-sm cursor-pointer hover:border hover:border-primary transition-all border"
                        onClick={() =>
                          handleSuggestionSelect(currentSuggestion)
                        }
                      >
                        <div className="flex items-center justify-between">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded-full"
                            onClick={handlePreviousSuggestion}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <div className="font-medium">{currentSuggestion}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded-full"
                            onClick={handleNextSuggestion}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                    {showInlineVoice && (
                      <VoiceAssistantInline
                        onSendVoice={handleSendFromVoiceDialog}
                        className="flex-shrink-0"
                        onClose={() => setShowInlineVoice(false)}
                        autoStart={!currentSuggestion}
                      />
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-background rounded-lg border border-border p-2">
                  <AutoResizeTextarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyPress}
                    placeholder={t("inputPlaceholder") as string}
                    className="flex-1 transition-all duration-100"
                    style={{
                      paddingRight: "8px",
                      paddingLeft: "8px",
                      fontSize: isMobile ? "16px" : "",
                    }}
                    minRows={1}
                    maxRows={6}
                  />
                  <Button
                    onClick={toggleRecording}
                    variant={isRecording ? "destructive" : "outline"}
                    size="icon"
                    className="rounded-full flex-shrink-0"
                    aria-label={
                      isRecording
                        ? (t("stopRecording") as string)
                        : (t("startRecording") as string)
                    }
                    disabled={isMessageLoading}
                  >
                    {isRecording ? (
                      <AudioWaveform
                        isActive={isRecording}
                        audioLevel={audioLevel}
                      />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </Button>
                  {/* Interactive mic button commented out */}
                  {/* <Button
                    onClick={() => setShowInlineVoice(true)}
                    variant="ghost"
                    size="icon"
                    className="rounded-full flex-shrink-0"
                    aria-label="AI Enhanced Voice"
                    disabled={isMessageLoading}
                  >
                    <MicVocal className="h-5 w-5" />
                  </Button> */}
                  <Button
                    onClick={handleSendMessage}
                    disabled={inputValue.trim() === "" || isMessageLoading}
                    variant="default"
                    size="icon"
                    className="rounded-full flex-shrink-0"
                    aria-label={t("send") as string}
                  >
                    <Send className="h-5 w-5" />
                  </Button>
                </div>
                <div className="text-[10px] text-muted-foreground text-center mt-2 flex items-center justify-center">
                  <Info className="h-3 w-3 mr-1 inline-block" />
                  {(t("disclaimerText") as string) ||
                    "Bharat Vistaar is AI and can make mistakes. Please verify sources."}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <FeedbackForm
        showFeedbackDialog={showFeedbackDialog}
        setShowFeedbackDialog={setShowFeedbackDialog}
        feedbackText={feedbackText}
        setFeedbackText={setFeedbackText}
        feedbackOptions={feedbackOptions}
        isFeedbackRecording={isFeedbackRecording}
        toggleFeedbackRecording={toggleFeedbackRecording}
        feedbackAudioLevel={feedbackAudioLevel}
        submitFeedback={submitFeedback}
      />
    </div>
  );
}
