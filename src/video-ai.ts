/** Browser-side provider client for the AI video editor. Keys stay in memory. */

export type AiProviderId = 'openai' | 'anthropic' | 'deepseek' | 'opencode' | 'custom';
export type AiApiStyle = 'auto' | 'openai' | 'anthropic';

export interface AiSettings {
  provider: AiProviderId;
  model: string;
  baseUrl: string;
  style: AiApiStyle;
  previewOnly: boolean;
  autoApprove: boolean;
}

export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AiChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AiCallResult {
  text: string;
  toolCalls: AiToolCall[];
}

export interface AiProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  style: AiApiStyle;
}

export const AI_PROVIDER_PRESETS: Record<AiProviderId, AiProviderPreset> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', style: 'openai' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', style: 'anthropic' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', style: 'openai' },
  opencode: { label: 'OpenCode', baseUrl: 'https://opencode.ai/inference/openai/v1', model: 'deepseek-v4.1-flash', style: 'openai' },
  custom: { label: 'Custom', baseUrl: '', model: '', style: 'openai' },
};

export function resolveAiStyle(settings: Pick<AiSettings, 'provider' | 'model' | 'style'>): 'openai' | 'anthropic' {
  if (settings.style === 'openai' || settings.style === 'anthropic') return settings.style;
  if (settings.provider === 'anthropic') return 'anthropic';
  return 'openai';
}

export function isLocalAiEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

export function providerNeedsKey(settings: Pick<AiSettings, 'provider' | 'baseUrl'>): boolean {
  return settings.provider !== 'custom' || !isLocalAiEndpoint(settings.baseUrl);
}

export function aiEndpoint(settings: Pick<AiSettings, 'baseUrl' | 'style' | 'provider' | 'model'>): string {
  const base = settings.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Add a base URL in AI settings.');
  const style = resolveAiStyle(settings);
  if (style === 'anthropic') return /\/messages$/i.test(base) ? base : `${base}/messages`;
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function openAiMessages(system: string, messages: readonly AiChatMessage[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      output.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
          : {}),
      });
    } else {
      output.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return output;
}

function anthropicMessages(messages: readonly AiChatMessage[]): { role: 'user' | 'assistant'; content: unknown }[] {
  const output: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      output.push({ role: 'assistant', content: blocks });
    } else {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = output[output.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        output.push({ role: 'user', content: [block] });
      }
    }
  }
  // Anthropic requires alternating roles. Merge same-role neighbours.
  const merged: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const message of output) {
    const last = merged[merged.length - 1];
    if (last?.role === message.role) {
      const left = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
      const right = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }];
      last.content = [...left, ...right];
    } else {
      merged.push(message);
    }
  }
  if (merged.length && merged[0].role === 'assistant') merged.unshift({ role: 'user', content: 'Continue.' });
  return merged;
}

function errorMessageFromBody(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === 'string') return body.error;
    if (body.error?.message) return body.error.message;
    if (body.message) return body.message;
  } catch {
    // Fall through to the raw response.
  }
  return text.trim().slice(0, 400);
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Could not reach the AI provider. Check the base URL, your connection, and whether the provider allows browser requests (CORS). ${error instanceof Error ? error.message : ''}`.trim());
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI provider returned ${response.status}. ${errorMessageFromBody(text)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('The AI provider returned a response that was not JSON.');
  }
}

export interface AiProviderRequest {
  settings: AiSettings;
  apiKey: string;
  system: string;
  messages: readonly AiChatMessage[];
  tools: readonly AiToolSpec[];
  signal?: AbortSignal;
}

export async function callAiProvider(request: AiProviderRequest): Promise<AiCallResult> {
  const { settings, apiKey, system, messages, tools, signal } = request;
  if (!settings.model.trim()) throw new Error('Add a model ID in AI settings.');
  const style = resolveAiStyle(settings);
  const url = aiEndpoint(settings);
  if (style === 'anthropic') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    const body = {
      model: settings.model,
      max_tokens: 4096,
      system,
      messages: anthropicMessages(messages),
      ...(tools.length
        ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
        : {}),
    };
    const data = await requestJson(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const content = Array.isArray(data.content) ? data.content as Record<string, unknown>[] : [];
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();
    const toolCalls = content
      .filter((block) => block.type === 'tool_use')
      .map((block, index) => ({
        id: String(block.id ?? `tool-${index}`),
        name: String(block.name ?? ''),
        arguments: (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>,
      }));
    return { text, toolCalls };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model: settings.model,
    messages: openAiMessages(system, messages),
    ...(tools.length
      ? {
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        tool_choice: 'auto',
      }
      : {}),
  };
  const data = await requestJson(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const choices = Array.isArray(data.choices) ? data.choices as Record<string, unknown>[] : [];
  const choice = choices[0] as { message?: Record<string, unknown>; text?: string } | undefined;
  const message = choice?.message;
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls as Record<string, unknown>[] : [];
  const toolCalls: AiToolCall[] = [];
  for (const [index, raw] of rawCalls.entries()) {
    const fn = raw.function as { name?: string; arguments?: string } | undefined;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fn?.arguments ?? '{}') as unknown;
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
    toolCalls.push({ id: String(raw.id ?? `call-${index}`), name: String(fn?.name ?? ''), arguments: args });
  }
  const content = message?.content;
  return {
    text: typeof content === 'string' ? content.trim() : choice?.text?.trim() ?? '',
    toolCalls,
  };
}
