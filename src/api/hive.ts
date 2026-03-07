// Hive API client

// Always use /api — the Vite dynamic proxy handles routing to the correct server
const API_BASE = '/api';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface Channel {
  id: string;
  name: string;
  description?: string;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  isPrivate?: boolean;
  members?: string[];
}

interface Post {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  mentions: string[];
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  spawnCommand?: string;
  spawnArgs?: string[];
  cwd?: string;
  capabilities?: string[];
  createdAt: number;
  updatedAt: number;
}

interface Mention {
  id: string;
  agentId: string;
  channelId: string;
  postId: string;
  content?: string;
  spawnStatus?: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

// API client
export const api = {
  // Channels
  async getChannels(): Promise<Channel[]> {
    const res = await fetch(`${API_BASE}/channels`);
    const json: ApiResponse<Channel[]> = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data!;
  },

  async createChannel(data: { name: string; description?: string; createdBy: string }): Promise<Channel> {
    const res = await fetch(`${API_BASE}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json: ApiResponse<Channel> = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data!;
  },

  // Posts
  async getPosts(channelId?: string): Promise<Post[]> {
    const url = channelId ? `${API_BASE}/posts?channelId=${channelId}` : `${API_BASE}/posts`;
    const res = await fetch(url);
    const json: ApiResponse<Post[]> = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data!;
  },

  async createPost(data: { channelId: string; authorId: string; content: string }): Promise<Post> {
    const res = await fetch(`${API_BASE}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json: ApiResponse<Post> = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data!;
  },

  // Agents
  async getAgents(): Promise<Agent[]> {
    const res = await fetch(`${API_BASE}/agents`);
    const json = await res.json();
    return json.agents || [];
  },

  // Mentions
  async getMentions(agentId?: string): Promise<Mention[]> {
    const url = agentId ? `${API_BASE}/mentions?agentId=${agentId}` : `${API_BASE}/mentions`;
    const res = await fetch(url);
    const json: ApiResponse<Mention[]> = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data!;
  },
};

// Types
export type { Channel, Post, Agent, Mention };