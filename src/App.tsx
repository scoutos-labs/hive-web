import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import {
  useChannels,
  useAgents,
  useChannel,
  useSSE,
  useMentions,
  useProgress,
  type HiveEvent,
  type ProgressMessage,
} from './hooks/data';
import { api, type Channel, type Post } from './api/hive';
import { initNotifications, notifyAgentComplete, notifyAgentFailed } from './notifications';
import {
  getCurrentServer,
  getDefaultServer,
  getServerHistory,
  isCustomServer,
  switchServer,
  clearServerOverride,
  removeFromHistory,
} from './server';
import './styles.css';

const UNREAD_STORAGE_KEY = 'hive-unread-counts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getEventPayload(event: HiveEvent): Record<string, unknown> {
  if (isRecord(event.payload)) return event.payload;
  return {};
}

function toPost(value: unknown): Post | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const channelId = typeof value.channelId === 'string' ? value.channelId : null;
  const authorId = typeof value.authorId === 'string' ? value.authorId : null;
  const content = typeof value.content === 'string' ? value.content : null;
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : null;

  if (!id || !channelId || !authorId || content === null || createdAt === null) {
    return null;
  }

  return {
    id,
    channelId,
    authorId,
    content,
    createdAt,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    mentions: Array.isArray(value.mentions)
      ? value.mentions.filter((mention): mention is string => typeof mention === 'string')
      : [],
  };
}

function getEventPost(event: HiveEvent): Post | null {
  const payload = getEventPayload(event);
  return toPost(payload.post) ?? toPost(payload.data) ?? toPost(event.post) ?? toPost(event.data);
}

function getEventChannelId(event: HiveEvent): string | null {
  const payload = getEventPayload(event);
  if (typeof payload.channelId === 'string') return payload.channelId;
  const post = getEventPost(event);
  if (post) return post.channelId;
  if (typeof event.channelId === 'string') return event.channelId;
  return null;
}

function toChannel(value: unknown): Channel | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const name = typeof value.name === 'string' ? value.name : null;
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : null;
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : null;

  if (!id || !name || createdAt === null || updatedAt === null) {
    return null;
  }

  return {
    id,
    name,
    description: typeof value.description === 'string' ? value.description : undefined,
    createdBy: typeof value.createdBy === 'string' ? value.createdBy : undefined,
    createdAt,
    updatedAt,
    isPrivate: typeof value.isPrivate === 'boolean' ? value.isPrivate : undefined,
    members: Array.isArray(value.members)
      ? value.members.filter((member): member is string => typeof member === 'string')
      : undefined,
  };
}

function getEventChannel(event: HiveEvent): Channel | null {
  const payload = getEventPayload(event);
  return toChannel(payload.channel) ?? toChannel(payload.data) ?? toChannel(event.channel) ?? toChannel(event.data);
}

function upsertChannel(items: Channel[], channel: Channel): Channel[] {
  const next = items.filter(item => item.id !== channel.id);
  next.push(channel);
  return next.sort((a, b) => a.createdAt - b.createdAt);
}

function sortPostsChronologically(items: Post[]): Post[] {
  return [...items].sort((a, b) => a.createdAt - b.createdAt);
}

function upsertPost(items: Post[], post: Post): Post[] {
  const next = items.filter(item => item.id !== post.id);
  next.push(post);
  return sortPostsChronologically(next);
}

function readStoredUnreadCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => {
        const [, value] = entry;
        return typeof value === 'number' && value > 0;
      })
    );
  } catch {
    return {};
  }
}

// Mention autocomplete component
function MentionAutocomplete({
  query,
  agents,
  position,
  onSelect
}: {
  query: string;
  agents: { id: string; name: string }[];
  position: { top: number; left: number };
  onSelect: (agentId: string) => void;
}) {
  const filtered = useMemo(() => {
    if (!query) return agents;
    const q = query.toLowerCase();
    return agents.filter(a => 
      a.id.toLowerCase().includes(q) || 
      a.name.toLowerCase().includes(q)
    );
  }, [query, agents]);

  if (filtered.length === 0) return null;

  return (
    <div 
      className="mention-autocomplete"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map(agent => (
        <div 
          key={agent.id} 
          className="mention-option"
          onClick={() => onSelect(agent.id)}
        >
          <span className="mention-option-icon" />
          <span className="mention-option-name">{agent.name}</span>
          <span className="mention-option-id">@{agent.id}</span>
        </div>
      ))}
    </div>
  );
}

// Server switcher bar
function ServerBar() {
  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const currentServer = getCurrentServer();
  const defaultServer = getDefaultServer();
  const isOverride = isCustomServer();
  const history = getServerHistory();

  // On mount, sync the proxy target with what's saved in localStorage
  useEffect(() => {
    if (isOverride) {
      fetch('/__hive__/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: currentServer }),
      }).catch(() => {}); // ignore errors (e.g. production, no dev server)
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!expanded) return;
    const handleClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [expanded]);

  // Focus input when expanding
  useEffect(() => {
    if (expanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [expanded]);

  const handleConnect = useCallback(() => {
    const url = inputValue.trim();
    if (!url) return;
    switchServer(url);
  }, [inputValue]);

  const handleReset = useCallback(() => {
    clearServerOverride();
    // Tell proxy to revert to default target
    fetch('/__hive__/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: defaultServer }),
    }).finally(() => window.location.reload());
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConnect();
    }
    if (e.key === 'Escape') {
      setExpanded(false);
    }
  }, [handleConnect]);

  return (
    <div className="server-bar" ref={barRef}>
      <div className="server-bar-main" onClick={() => setExpanded(!expanded)}>
        <span className="server-bar-label">SERVER</span>
        <span className="server-bar-url">{currentServer}</span>
        {isOverride && (
          <span className="server-bar-badge">custom</span>
        )}
        <span className="server-bar-toggle">{expanded ? '\u25B4' : '\u25BE'}</span>
      </div>

      {expanded && (
        <div className="server-bar-dropdown">
          <div className="server-bar-input-row">
            <input
              ref={inputRef}
              className="server-bar-input"
              type="text"
              placeholder="http://hostname:3000"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="server-bar-connect"
              onClick={handleConnect}
              disabled={!inputValue.trim()}
            >
              Connect
            </button>
          </div>

          {history.length > 0 && (
            <div className="server-bar-history">
              <div className="server-bar-history-title">Recent Servers</div>
              {history.map(url => (
                <div key={url} className="server-bar-history-item">
                  <button
                    className="server-bar-history-url"
                    onClick={() => switchServer(url)}
                  >
                    {url}
                    {url === currentServer && <span className="server-bar-active-dot" />}
                  </button>
                  <button
                    className="server-bar-history-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromHistory(url);
                      setExpanded(false);
                      setTimeout(() => setExpanded(true), 0);
                    }}
                    title="Remove from history"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          {isOverride && (
            <button className="server-bar-reset" onClick={handleReset}>
              Reset to default ({defaultServer})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Active tasks sidebar section
function ActiveTasks({ mentions }: { mentions: ReturnType<typeof useMentions>['mentions'] }) {
  const running = mentions.filter(m => m.spawnStatus === 'running');
  const pending = mentions.filter(m => m.spawnStatus === 'pending');
  const recent = [...running, ...pending].slice(0, 5);

  if (recent.length === 0) return null;

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        // active_tasks
        {running.length > 0 && <span className="badge">{running.length}</span>}
      </div>
      {recent.map(mention => (
        <div key={mention.id} className={`task-item ${mention.spawnStatus}`}>
          <div className="task-item-status">
            {mention.spawnStatus === 'pending' && '○'}
            {mention.spawnStatus === 'running' && <span className="spin">◐</span>}
          </div>
          <div className="task-item-info">
            <div className="task-item-agent">@{mention.agentId}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Main App
export default function App() {
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [channelScrollToken, setChannelScrollToken] = useState(0);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(() => readStoredUnreadCounts());
  const { channels, loading: channelsLoading, refetch: refetchChannels } = useChannels();
  const { mentions, refetch: refetchMentions } = useMentions();
  const { lastEvent, connected } = useSSE('/api/events/stream');
  const [liveChannels, setLiveChannels] = useState<Channel[]>([]);
  
  // Initialize notifications on mount
  useEffect(() => {
    initNotifications();
  }, []);

  useEffect(() => {
    setLiveChannels(channels);
  }, [channels]);

  useEffect(() => {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(unreadCounts));
  }, [unreadCounts]);

  useEffect(() => {
    if (!lastEvent) return;

    if (lastEvent.type === 'post.created') {
      const eventPost = getEventPost(lastEvent);
      if (eventPost && eventPost.channelId !== selectedChannelId) {
        setUnreadCounts(prev => ({
          ...prev,
          [eventPost.channelId]: (prev[eventPost.channelId] ?? 0) + 1,
        }));
      }
    }

    if (lastEvent.type === 'channel.created' || lastEvent.type === 'channel.updated') {
      const eventChannel = getEventChannel(lastEvent);
      if (eventChannel) {
        setLiveChannels(prev => upsertChannel(prev, eventChannel));
      } else {
        refetchChannels();
      }
    }
  }, [lastEvent, refetchChannels, selectedChannelId]);

  // Select first channel by default
  useEffect(() => {
    if (!selectedChannelId && liveChannels.length > 0) {
      setSelectedChannelId(liveChannels[0].id);
    }
  }, [liveChannels, selectedChannelId]);

  const handleSelectChannel = useCallback((id: string) => {
    setSelectedChannelId(id);
    setChannelScrollToken(prev => prev + 1);
    setUnreadCounts(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return (
    <div className="app-wrapper">
      <ServerBar />
      <div className="app">
        <Sidebar
          channels={liveChannels}
          loading={channelsLoading}
          selectedChannelId={selectedChannelId}
          onSelectChannel={handleSelectChannel}
          mentions={mentions}
          unreadCounts={unreadCounts}
        />
        <Main
          channelId={selectedChannelId}
          channelScrollToken={channelScrollToken}
          connected={connected}
          lastEvent={lastEvent}
          clearChannelUnread={(id) => {
            setUnreadCounts(prev => {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }}
          onTaskUpdate={refetchMentions}
        />
      </div>
    </div>
  );
}

// Sidebar
function Sidebar({ 
  channels, 
  loading, 
  selectedChannelId,
  onSelectChannel,
  mentions,
  unreadCounts,
}: { 
  channels: ReturnType<typeof useChannels>['channels'];
  loading: boolean;
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  mentions: ReturnType<typeof useMentions>['mentions'];
  unreadCounts: Record<string, number>;
}) {
  const { agents, loading: agentsLoading } = useAgents();
  
  // Get agent IDs with running tasks
  const runningAgentIds = useMemo(() => {
    return new Set(
      mentions
        .filter(m => m.spawnStatus === 'running' || m.spawnStatus === 'pending')
        .map(m => m.agentId)
    );
  }, [mentions]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">H</div>
          <span>HIVE_WEB</span>
        </div>
      </div>
      
      <div className="sidebar-section">
        <div className="sidebar-section-title">// channels</div>
        {loading ? (
          <div className="sidebar-item" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : channels.length === 0 ? (
          <div className="sidebar-item" style={{ color: 'var(--text-muted)' }}>No channels</div>
        ) : (
          channels.map(channel => (
            <div
              key={channel.id}
              className={`sidebar-item ${selectedChannelId === channel.id ? 'active' : ''}`}
              onClick={() => onSelectChannel(channel.id)}
            >
              <span className="sidebar-item-icon">#</span>
              <span className="sidebar-item-name">{channel.name}</span>
              {(unreadCounts[channel.id] ?? 0) > 0 && (
                <span className="badge channel-unread-badge">
                  {unreadCounts[channel.id] > 99 ? '99+' : unreadCounts[channel.id]}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">// agents</div>
        {agentsLoading ? (
          <div className="sidebar-item" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : (
          agents.map(agent => {
            const isRunning = runningAgentIds.has(agent.id);
            return (
              <div key={agent.id} className={`agent-item ${isRunning ? 'running' : ''}`}>
                <div className={`agent-avatar ${isRunning ? 'running' : ''}`}>
                  {agent.id.charAt(0).toUpperCase()}
                </div>
                <div className="agent-item-info">
                  <div className="agent-item-name">{agent.name}</div>
                  <div className="agent-item-status">
                    {isRunning ? '[RUNNING]' : '[IDLE]'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ActiveTasks mentions={mentions} />

      <button 
        className="sidebar-new-channel"
        onClick={() => {
          const name = prompt('Channel name:');
          if (name) {
            api.createChannel({ name, createdBy: 'user' });
          }
        }}
      >
        + new_channel
      </button>
    </aside>
  );
}

// Thinking indicator with elapsed time
function ThinkingIndicator({ startTime, nextPollIn, onCancel }: { startTime: number; nextPollIn: number; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const formatElapsed = (secs: number): string => {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="thinking-indicator">
      <div className="thinking-dots">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </div>
      <div className="thinking-text">
        <span className="thinking-label">Thinking...</span>
        <span className="thinking-elapsed">{formatElapsed(elapsed)}</span>
        <span className="thinking-poll">next check in {Math.ceil(nextPollIn / 1000)}s</span>
      </div>
      <button className="thinking-cancel" onClick={onCancel} title="Cancel waiting">
        Cancel
      </button>
    </div>
  );
}

// Main content area
function Main({
  channelId,
  channelScrollToken,
  connected,
  lastEvent,
  clearChannelUnread,
  onTaskUpdate,
}: {
  channelId: string | null;
  channelScrollToken: number;
  connected: boolean;
  lastEvent: HiveEvent | null;
  clearChannelUnread: (id: string) => void;
  onTaskUpdate: () => void;
}) {
  const { channel, posts, loading, refetchPosts } = useChannel(channelId);
  const { progressMessages, streamingAgentId, addProgress, clearProgress } = useProgress(channelId);
  const INITIAL_VISIBLE_POSTS = 120;
  const LOAD_MORE_POSTS = 80;
  const TOP_LOAD_THRESHOLD = 120;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [livePosts, setLivePosts] = useState<Post[]>([]);
  const isNearBottom = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const prevPostCount = useRef(0);
  const [visibleStartIndex, setVisibleStartIndex] = useState(0);
  const pendingPrependAdjust = useRef<{ previousHeight: number; previousTop: number } | null>(null);
  const lastChannelId = useRef<string | null>(null);
  const visibleLivePosts = useMemo(() => livePosts.slice(visibleStartIndex), [livePosts, visibleStartIndex]);

  const getDistanceFromBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return Number.POSITIVE_INFINITY;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const checkIfNearBottom = useCallback(() => {
    const threshold = 100;
    const nextIsNearBottom = getDistanceFromBottom() < threshold;
    isNearBottom.current = nextIsNearBottom;
    setIsAtBottom(nextIsNearBottom);
    if (nextIsNearBottom) {
      setNewMessageCount(0);
    }
  }, [getDistanceFromBottom]);

  const loadOlderPosts = useCallback(() => {
    if (visibleStartIndex <= 0) return;
    const el = messagesContainerRef.current;
    if (el) {
      pendingPrependAdjust.current = {
        previousHeight: el.scrollHeight,
        previousTop: el.scrollTop,
      };
    }
    setVisibleStartIndex(prev => Math.max(0, prev - LOAD_MORE_POSTS));
  }, [visibleStartIndex, LOAD_MORE_POSTS]);

  const handleMessagesScroll = useCallback(() => {
    checkIfNearBottom();
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollTop <= TOP_LOAD_THRESHOLD && visibleStartIndex > 0) {
      loadOlderPosts();
    }
  }, [checkIfNearBottom, visibleStartIndex, loadOlderPosts, TOP_LOAD_THRESHOLD]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
    setNewMessageCount(0);
    isNearBottom.current = true;
    setIsAtBottom(true);
  }, []);

  useLayoutEffect(() => {
    const pending = pendingPrependAdjust.current;
    if (!pending) return;
    const el = messagesContainerRef.current;
    if (!el) return;

    const heightDelta = el.scrollHeight - pending.previousHeight;
    el.scrollTop = pending.previousTop + heightDelta;
    pendingPrependAdjust.current = null;
  }, [visibleStartIndex, livePosts.length, progressMessages.length]);

  useEffect(() => {
    setLivePosts(sortPostsChronologically(posts));
  }, [posts]);

  const [thinking, setThinking] = useState(false);
  const [thinkingStart, setThinkingStart] = useState(0);
  const [nextPollIn, setNextPollIn] = useState(0);
  const postCountAtSend = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffStep = useRef(0);

  const INITIAL_DELAY = 15_000;
  const MAX_DELAY = 120_000;

  const clearPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    setThinking(false);
    setNextPollIn(0);
    backoffStep.current = 0;
  }, []);

  const scheduleNextPoll = useCallback(() => {
    const delay = Math.min(INITIAL_DELAY * Math.pow(2, backoffStep.current), MAX_DELAY);
    setNextPollIn(delay);

    pollTimer.current = setTimeout(async () => {
      await refetchPosts();
      backoffStep.current += 1;
      scheduleNextPoll();
    }, delay);
  }, [refetchPosts]);

  const handleUserSent = useCallback((hasMention: boolean) => {
    refetchPosts();
    onTaskUpdate();
    if (hasMention) {
      postCountAtSend.current = livePosts.length + 1;
      setThinking(true);
      setThinkingStart(Date.now());
      backoffStep.current = 0;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      scheduleNextPoll();
    }
  }, [refetchPosts, onTaskUpdate, livePosts.length, scheduleNextPoll]);

  useEffect(() => {
    if (!thinking) return;
    if (livePosts.length > postCountAtSend.current) {
      const newPosts = livePosts.slice(postCountAtSend.current);
      const hasAgentResponse = newPosts.some(p => p.authorId !== 'user');
      if (hasAgentResponse) {
        clearPolling();
      }
    }
  }, [livePosts, thinking, clearPolling]);

  useEffect(() => {
    if (!thinking || !lastEvent) return;
    if (lastEvent.type === 'task.completed' || lastEvent.type === 'task.failed') {
      clearPolling();
    }
  }, [lastEvent, thinking, clearPolling]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [channelId]);

  useEffect(() => {
    clearPolling();
    setLivePosts([]);
    prevPostCount.current = 0;
    setNewMessageCount(0);
    isNearBottom.current = true;
    setIsAtBottom(true);
    requestAnimationFrame(() => scrollToBottom('auto'));
  }, [channelId, clearPolling, scrollToBottom]);

  useEffect(() => {
    if (!channelId) return;
    requestAnimationFrame(() => scrollToBottom('auto'));
  }, [channelId, channelScrollToken, scrollToBottom]);

  useEffect(() => {
    if (!channelId || !isAtBottom) return;
    clearChannelUnread(channelId);
  }, [channelId, isAtBottom, clearChannelUnread]);

  useEffect(() => {
    if (channelId === null) {
      lastChannelId.current = null;
      setVisibleStartIndex(0);
      return;
    }
    if (loading) return;

    const switchedChannel = lastChannelId.current !== channelId;
    if (!switchedChannel) return;

    const start = Math.max(0, livePosts.length - INITIAL_VISIBLE_POSTS);
    setVisibleStartIndex(start);
    setNewMessageCount(0);
    prevPostCount.current = livePosts.length;
    lastChannelId.current = channelId;

    requestAnimationFrame(() => {
      const el = messagesContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      isNearBottom.current = true;
      setIsAtBottom(true);
    });
  }, [channelId, loading, livePosts.length, INITIAL_VISIBLE_POSTS]);

  useEffect(() => {
    setVisibleStartIndex(prev => Math.min(prev, Math.max(0, livePosts.length - 1)));
  }, [livePosts.length]);

  useEffect(() => {
    const nearBottom = getDistanceFromBottom() < 100;
    const newCount = livePosts.length - prevPostCount.current;

    if (prevPostCount.current > 0 && newCount > 0) {
      if (nearBottom) {
        scrollToBottom();
      } else {
        setNewMessageCount(prev => prev + newCount);
      }
    }

    isNearBottom.current = nearBottom;
    setIsAtBottom(nearBottom);
    prevPostCount.current = livePosts.length;
  }, [livePosts, getDistanceFromBottom, scrollToBottom]);

  useEffect(() => {
    if (!streamingAgentId || progressMessages.length === 0) return;

    const nearBottom = getDistanceFromBottom() < 100;
    if (!nearBottom && !isNearBottom.current) return;

    const el = messagesContainerRef.current;
    if (!el) return;

    el.scrollTop = el.scrollHeight;
    isNearBottom.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);
  }, [progressMessages, streamingAgentId, getDistanceFromBottom]);

  useEffect(() => {
    if (thinking && isNearBottom.current) {
      scrollToBottom();
    }
  }, [thinking, scrollToBottom]);

  useEffect(() => {
    if (!lastEvent) return;

    const payload = getEventPayload(lastEvent);
    const eventChannelId = getEventChannelId(lastEvent);
    const isActiveChannelEvent = !channelId || !eventChannelId || eventChannelId === channelId;

    if (lastEvent.type === 'task.progress') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
      const progressChannelId = typeof payload.channelId === 'string' ? payload.channelId : null;
      const chunk = typeof payload.chunk === 'string' ? payload.chunk : null;
      if (agentId && progressChannelId && chunk) {
        addProgress({ agentId, channelId: progressChannelId, chunk });
      }
      return;
    }

    if (lastEvent.type === 'post.created' || lastEvent.type === 'post.updated') {
      const eventPost = getEventPost(lastEvent);
      if (eventPost && (!channelId || eventPost.channelId === channelId)) {
        setLivePosts(prev => upsertPost(prev, eventPost));
      } else if (isActiveChannelEvent) {
        refetchPosts();
      }
      return;
    }

    if (lastEvent.type === 'channel.created' || lastEvent.type === 'channel.updated') {
      if (isActiveChannelEvent) {
        refetchPosts();
      }
      return;
    }

    if (lastEvent.type === 'task.completed') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
      clearProgress(agentId);
      if (isActiveChannelEvent) {
        refetchPosts();
      }
      onTaskUpdate();
      const channelName = channel?.name || 'unknown';
      notifyAgentComplete(agentId || 'agent', channelName);
      return;
    }

    if (lastEvent.type === 'task.failed') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined;
      clearProgress(agentId);
      if (isActiveChannelEvent) {
        refetchPosts();
      }
      onTaskUpdate();
      const channelName = channel?.name || 'unknown';
      const error = typeof payload.error === 'string' ? payload.error : undefined;
      notifyAgentFailed(agentId || 'agent', channelName, error);
      return;
    }

    if (lastEvent.type === 'task.started') {
      clearProgress();
      onTaskUpdate();
      return;
    }

    if (lastEvent.type === 'mention.updated') {
      onTaskUpdate();
    }
  }, [lastEvent, refetchPosts, onTaskUpdate, channel, channelId, addProgress, clearProgress]);

  return (
    <div className="main">
      <header className="main-header">
        {channel ? (
          <>
            <h1 className="main-title">#{channel.name}</h1>
            <div className="main-meta">
              <span className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}>
                <span className={`status-dot ${connected ? 'completed' : 'idle'}`}></span>
                {connected ? 'SSE [CONNECTED]' : 'SSE [DISCONNECTED]'}
              </span>
            </div>
          </>
        ) : (
          <h1 className="main-title">select_channel //</h1>
        )}
      </header>

      <div className="messages-container-wrapper">
        <div className="messages-container" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
          {loading ? (
            <div className="empty-state">
              <div className="empty-state-icon">⏳</div>
              <div className="empty-state-title">Loading...</div>
            </div>
          ) : !channel ? (
            <div className="empty-state">
              <div className="empty-state-icon" style={{ background: 'var(--accent-orange)', width: 64, height: 64, borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, color: 'var(--text-on-accent)', fontFamily: 'var(--font-display)', fontWeight: 700 }}>H</div>
              <div className="empty-state-title">welcome_to_hive //</div>
              <div className="empty-state-desc">Communicate with AI agents in real-time channels. Select a channel from the sidebar to get started.</div>
            </div>
          ) : livePosts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon" style={{ fontSize: 32, opacity: 0.3 }}>#</div>
              <div className="empty-state-title">no_messages //</div>
              <div className="empty-state-desc">Be the first to post in #{channel.name}. Use @agent_name to mention agents.</div>
            </div>
          ) : (
            <>
              {visibleLivePosts.map(post => (
                <Message key={post.id} post={post} />
              ))}
              {progressMessages.map(msg => (
                <ProgressMessage key={msg.id} message={msg} />
              ))}
              {thinking && (
                <ThinkingIndicator startTime={thinkingStart} nextPollIn={nextPollIn} onCancel={clearPolling} />
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {(!isAtBottom || newMessageCount > 0) && (
          <button className="new-messages-btn" onClick={() => scrollToBottom()}>
            {newMessageCount > 0
              ? `${newMessageCount} new message${newMessageCount !== 1 ? 's' : ''} - jump to latest`
              : 'Jump to latest'}
          </button>
        )}
      </div>

      {channel && (
        <Composer channelId={channel.id} posts={livePosts} onSend={handleUserSent} />
      )}
    </div>
  );
}

// Progress message component - shows streaming output from agents
function ProgressMessage({ message }: { message: ProgressMessage }) {
  const { agents } = useAgents();
  const agent = agents.find(a => a.id === message.agentId);
  
  // Format timestamp
  const time = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  // Format content - handle both plain text and JSONL
  const formatContent = (content: string): string => {
    if (!content) return '';
    
    // Try to parse as JSONL and extract text
    const lines = content.split('\n').filter(l => l.trim());
    const texts: string[] = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'text' && parsed.content) {
          texts.push(parsed.content);
        } else if (parsed.type === 'text' && parsed.text) {
          texts.push(parsed.text);
        } else if (parsed.text) {
          texts.push(parsed.text);
        }
      } catch {
        // Not JSON, treat as plain text
        texts.push(line);
      }
    }
    
    return texts.join('\n');
  };

  const formattedContent = formatContent(message.content);
  const lineCount = formattedContent.split('\n').length;
  const shouldCollapse = lineCount > 10 && !formattedContent.includes('```');
  
  const [expanded, setExpanded] = useState(!shouldCollapse);

  return (
    <div className="message agent streaming">
      <div className="agent-avatar running">
        {message.agentId.charAt(0).toUpperCase()}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-author">{agent?.name || message.agentId}</span>
          <span className="message-time">
            <span className="streaming-indicator">◐ streaming...</span>
            <span className="message-elapsed">{time}</span>
          </span>
        </div>
        <div className="message-body streaming-body">
          <pre className={expanded ? '' : 'collapsed'}>
            {formattedContent}
          </pre>
          {shouldCollapse && (
            <button className="message-toggle" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show more (${lineCount} lines)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Message component
const COLLAPSE_LINE_THRESHOLD = 20;

function Message({ post }: { post: Post }) {
  const { agents } = useAgents();
  const agent = agents.find(a => a.id === post.authorId);
  const isAgent = agent !== undefined;
  const [expanded, setExpanded] = useState(false);
  
  // Format timestamp
  const time = new Date(post.createdAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  // Extract text from a single JSON event payload
  const extractText = (jsonStr: string): string | null => {
    try {
      const parsed = JSON.parse(jsonStr);
      // Handle Hive event format: { type, part: { text } }
      if (parsed.part?.text) return parsed.part.text;
      // Handle simple { text } format
      if (typeof parsed.text === 'string') return parsed.text;
      // Handle { content } format
      if (typeof parsed.content === 'string') return parsed.content;
      // Handle { message } format
      if (typeof parsed.message === 'string') return parsed.message;
      return null;
    } catch {
      return null;
    }
  };

  // Parse content — extract text from JSON event payloads if needed
  // Handles single JSON objects and newline-delimited JSON (multiple events)
  const parseContent = (content: string): string => {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return content;

    // Try single JSON object first
    const single = extractText(trimmed);
    if (single !== null) return single;

    // Try newline-delimited JSON (multiple events in one content field)
    const lines = trimmed.split('\n').filter(l => l.trim().startsWith('{'));
    if (lines.length > 1) {
      const texts = lines
        .map(line => extractText(line.trim()))
        .filter((t): t is string => t !== null);
      if (texts.length > 0) return texts.join('');
    }

    // Fallback: return original
    return content;
  };

  // Highlight @mentions
  const formatContent = (content: string) => {
    const text = parseContent(content);
    const parts = text.split(/(@\w+)/g);
    return parts.map((part, i) => {
      if (part.startsWith('@')) {
        return <span key={i} style={{ color: 'var(--accent-orange)' }}>{part}</span>;
      }
      return part;
    });
  };

  const parsedText = parseContent(post.content);
  const lineCount = parsedText.split('\n').length;
  const isLong = lineCount > COLLAPSE_LINE_THRESHOLD;

  return (
    <div className={`message ${isAgent ? 'agent' : ''}`}>
      <div className="agent-avatar">
        {post.authorId.charAt(0).toUpperCase()}
      </div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-author">{post.authorId}</span>
          <span className="message-time">{time}</span>
        </div>
        <div className={`message-body ${isLong && !expanded ? 'collapsed' : ''}`}>
          {formatContent(post.content)}
        </div>
        {isLong && (
          <button className="message-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `Show more (${lineCount} lines)`}
          </button>
        )}
      </div>
    </div>
  );
}

// Composer component
function Composer({ channelId, posts, onSend }: { channelId: string; posts: Post[]; onSend: (hasMention: boolean) => void }) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { agents } = useAgents();

  // Detect implied agent from conversation context
  // Walk backwards: find the last agent who responded, and check if
  // the user previously mentioned them — implies ongoing conversation
  const impliedAgent = useMemo(() => {
    if (posts.length < 2) return null;
    const agentIds = new Set(agents.map(a => a.id));

    // Walk backwards to find the pattern: user mentioned agent -> agent replied
    for (let i = posts.length - 1; i >= 0; i--) {
      const post = posts[i];
      // Found an agent's reply — check if user mentioned them earlier
      if (agentIds.has(post.authorId)) {
        const agentId = post.authorId;
        // Look further back for a user message that mentioned this agent
        for (let j = i - 1; j >= 0; j--) {
          if (posts[j].authorId === 'user' && posts[j].content.includes(`@${agentId}`)) {
            return agentId;
          }
          // If we hit another agent's message, stop — context changed
          if (agentIds.has(posts[j].authorId) && posts[j].authorId !== agentId) {
            break;
          }
        }
        break; // only check the most recent agent reply
      }
      // If we hit a user message without finding an agent reply first, no implied agent
      if (post.authorId === 'user') break;
    }
    return null;
  }, [posts, agents]);

  const handleSubmit = async () => {
    if (!content.trim() || sending) return;
    
    const hasExplicitMention = /@\w+/.test(content);
    const willImply = !hasExplicitMention && impliedAgent !== null;
    const finalContent = willImply ? `@${impliedAgent} ${content.trim()}` : content.trim();
    const hasMention = hasExplicitMention || willImply;

    setSending(true);
    try {
      await api.createPost({
        channelId,
        authorId: 'user',
        content: finalContent,
      });
      setContent('');
      setMentionQuery(null);
      onSend(hasMention);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      setMentionQuery(null);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setContent(value);

    // Check for @mention trigger
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      // Calculate position for dropdown
      const textarea = e.target;
      const rect = textarea.getBoundingClientRect();
      setMentionPosition({
        top: rect.height,
        left: 0
      });
    } else {
      setMentionQuery(null);
    }
  };

  const handleMentionSelect = (agentId: string) => {
    if (!inputRef.current) return;
    
    const cursorPos = inputRef.current.selectionStart;
    const textBeforeCursor = content.substring(0, cursorPos);
    const textAfterCursor = content.substring(cursorPos);
    
    // Replace @partial with @agentId
    const newText = textBeforeCursor.replace(/@\w*$/, `@${agentId} `) + textAfterCursor;
    setContent(newText);
    setMentionQuery(null);
    
    // Focus back on input
    inputRef.current.focus();
  };

  const placeholder = impliedAgent
    ? `Reply to @${impliedAgent}... (mention auto-added)`
    : 'Type a message... Use @agent to mention agents';

  return (
    <div className="composer">
      {impliedAgent && !/@\w+/.test(content) && content.trim() && (
        <div className="composer-implied">
          replying to <span className="composer-implied-agent">@{impliedAgent}</span>
        </div>
      )}
      <div className="input-wrapper">
        <textarea
          ref={inputRef}
          className="input"
          placeholder={placeholder}
          value={content}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
        />
        <button
          className="input-submit"
          onClick={handleSubmit}
          disabled={!content.trim() || sending}
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
      
      {mentionQuery !== null && (
        <MentionAutocomplete
          query={mentionQuery}
          agents={agents}
          position={mentionPosition}
          onSelect={handleMentionSelect}
        />
      )}
    </div>
  );
}
