import { useState, useEffect, useRef } from 'react';
import { api, type Channel, type Post, type Agent, type Mention } from '../api/hive';

// Progress message from SSE task.progress events
export interface ProgressMessage {
  id: string;
  agentId: string;
  channelId: string;
  content: string;
  timestamp: number;
}

// Channels hook
export function useChannels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchChannels = async () => {
    try {
      setLoading(true);
      const data = await api.getChannels();
      setChannels(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch channels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchChannels();
  }, []);

  return { channels, loading, error, refetch: fetchChannels };
}

// Posts hook
export function usePosts(channelId: string | null) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPosts = async () => {
    if (!channelId) {
      setPosts([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const data = await api.getPosts(channelId);
      // Sort by creation time, oldest first for chat
      setPosts(data.sort((a, b) => a.createdAt - b.createdAt));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch posts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, [channelId]);

  return { posts, loading, error, refetch: fetchPosts };
}

// Agents hook
export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAgents() {
      try {
        setLoading(true);
        const data = await api.getAgents();
        setAgents(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch agents');
      } finally {
        setLoading(false);
      }
    }
    fetchAgents();
  }, []);

  return { agents, loading, error };
}

// Mentions hook (for active tasks)
export function useMentions(agentId?: string) {
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMentions() {
      try {
        setLoading(true);
        const data = await api.getMentions(agentId);
        // Sort by creation time, most recent first
        setMentions(data.sort((a, b) => b.createdAt - a.createdAt));
      } catch (err) {
        console.error('Failed to fetch mentions:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchMentions();
  }, [agentId]);

  return { mentions, loading, refetch: () => api.getMentions(agentId).then(setMentions) };
}

// SSE hook for real-time events
export function useSSE(url: string) {
  const [events, setEvents] = useState<any[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(url);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [url]);

  return { events, connected };
}

// Combined hook for channel view
export function useChannel(channelId: string | null) {
  const { posts, loading: postsLoading, refetch: refetchPosts } = usePosts(channelId);
  const { channels, loading: channelsLoading } = useChannels();

  const channel = channelId ? channels.find(c => c.id === channelId) : null;

  return {
    channel,
    channels,
    posts,
    loading: postsLoading || channelsLoading,
    refetchPosts,
  };
}

// Hook for managing streaming progress messages
export function useProgress(channelId: string | null) {
  const [progressMessages, setProgressMessages] = useState<ProgressMessage[]>([]);
  const [streamingAgentId, setStreamingAgentId] = useState<string | null>(null);
  const accumulatedRef = useRef<Map<string, string>>(new Map());

  // Add a progress chunk from SSE
  const addProgress = (event: { agentId: string; channelId: string; chunk: string }) => {
    if (!channelId || event.channelId !== channelId) return;
    
    // Accumulate chunks for this agent
    const existing = accumulatedRef.current.get(event.agentId) || '';
    accumulatedRef.current.set(event.agentId, existing + event.chunk);
    
    setStreamingAgentId(event.agentId);
    
    // Update progress message with accumulated content
    setProgressMessages(prev => {
      const filtered = prev.filter(p => p.agentId !== event.agentId);
      return [...filtered, {
        id: `progress-${event.agentId}`,
        agentId: event.agentId,
        channelId: event.channelId,
        content: accumulatedRef.current.get(event.agentId) || '',
        timestamp: Date.now(),
      }];
    });
  };

  // Clear progress (when agent completes or fails)
  const clearProgress = (agentId?: string) => {
    if (agentId) {
      accumulatedRef.current.delete(agentId);
      setProgressMessages(prev => prev.filter(p => p.agentId !== agentId));
      setStreamingAgentId(prev => prev === agentId ? null : prev);
    } else {
      accumulatedRef.current.clear();
      setProgressMessages([]);
      setStreamingAgentId(null);
    }
  };

  // Clear progress when switching channels
  useEffect(() => {
    accumulatedRef.current.clear();
    setProgressMessages([]);
    setStreamingAgentId(null);
  }, [channelId]);

  return {
    progressMessages,
    streamingAgentId,
    addProgress,
    clearProgress,
  };
}