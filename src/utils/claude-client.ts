import { logger } from './logger';
import { config } from '../config';
import { dash } from '../dashboard/events';

// Module-level DB reference — set once at startup via initClaudeMonitoring()
let _dbPool: { query: (text: string, params?: any[]) => Promise<any> } | null = null;

export function initClaudeMonitoring(db: { query: (text: string, params?: any[]) => Promise<any> }): void {
  _dbPool = db;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string;
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

export interface ClaudeResponse {
  stop_reason: 'end_turn' | 'tool_use' | string;
  content: ContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}

const URL = 'https://bnt-openai.services.ai.azure.com/anthropic/v1/messages';
const API_KEY = config.apis.azure.apiKey;

export async function callClaude(params: {
  system?: string;
  messages: Message[];
  tools?: Tool[];
  max_tokens?: number;
  source?: string;
}): Promise<ClaudeResponse> {

  const body: any = {
    model: config.apis.azure.model,
    max_tokens: params.max_tokens || 4096,
    messages: params.messages,
  };

  if (params.system) body.system = params.system;
  if (params.tools?.length) body.tools = params.tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('Claude API timeout (30s)');
    throw error;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, error: err }, 'Claude API error');
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json() as ClaudeResponse;
  logger.debug('✅ Claude API call successful');
  if (data.usage) {
    const { input_tokens, output_tokens } = data.usage;
    const src = params.source || 'claude';

    // Real-time SSE to dashboard
    dash.emit('tokens', { input: input_tokens, output: output_tokens, source: src });
    dash.emit('log', {
      severity: 'claude',
      message: `🤖 [${src}] in:${input_tokens.toLocaleString()} out:${output_tokens.toLocaleString()} · ${data.stop_reason}`,
    });

    // Persistent DB record — survives restarts
    if (_dbPool) {
      _dbPool.query(
        `INSERT INTO system_events (event_type, severity, message, metadata)
         VALUES ('llm_usage', 'info', $1, $2)`,
        [
          `[${src}] in:${input_tokens} out:${output_tokens}`,
          JSON.stringify({ source: src, input_tokens, output_tokens, stop_reason: data.stop_reason }),
        ],
      ).catch(() => {}); // fire-and-forget, never block the LLM response
    }
  }
  return data;
}
