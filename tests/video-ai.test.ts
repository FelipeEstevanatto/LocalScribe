import { describe, expect, test } from 'bun:test';
import {
  AI_PROVIDER_PRESETS,
  aiEndpoint,
  callAiProvider,
  providerNeedsKey,
  resolveAiStyle,
  type AiSettings,
} from '../src/video-ai';

const baseSettings: AiSettings = {
  provider: 'openai',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
  style: 'openai',
  previewOnly: true,
  autoApprove: false,
};

describe('AI provider settings', () => {
  test('resolves API style from provider and model', () => {
    expect(resolveAiStyle({ provider: 'openai', model: 'gpt-4o', style: 'auto' })).toBe('openai');
    expect(resolveAiStyle({ provider: 'anthropic', model: 'claude-sonnet-4-5', style: 'auto' })).toBe('anthropic');
    expect(resolveAiStyle({ provider: 'deepseek', model: 'deepseek-chat', style: 'auto' })).toBe('openai');
    expect(resolveAiStyle({ provider: 'opencode', model: 'claude-sonnet-4-5', style: 'auto' })).toBe('openai');
    expect(resolveAiStyle({ provider: 'opencode', model: 'deepseek-v4.1-flash', style: 'auto' })).toBe('openai');
    expect(resolveAiStyle({ provider: 'custom', model: 'x', style: 'openai' })).toBe('openai');
  });

  test('builds endpoints and avoids doubling the path', () => {
    expect(aiEndpoint({ ...baseSettings })).toBe('https://api.openai.com/v1/chat/completions');
    expect(aiEndpoint({ ...baseSettings, provider: 'anthropic', style: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(aiEndpoint({ ...baseSettings, baseUrl: 'https://example.com/v1/chat/completions' }))
      .toBe('https://example.com/v1/chat/completions');
    expect(() => aiEndpoint({ ...baseSettings, baseUrl: '' })).toThrow();
  });

  test('allows local custom endpoints without a key', () => {
    expect(providerNeedsKey({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
    expect(providerNeedsKey({ provider: 'custom', baseUrl: 'http://localhost:11434/v1' })).toBe(false);
    expect(providerNeedsKey({ provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe(false);
    expect(providerNeedsKey({ provider: 'custom', baseUrl: 'https://example.com/v1' })).toBe(true);
  });

  test('ships model presets for the supported providers', () => {
    expect(AI_PROVIDER_PRESETS.openai.model).toBeTruthy();
    expect(AI_PROVIDER_PRESETS.anthropic.baseUrl).toContain('anthropic');
    expect(AI_PROVIDER_PRESETS.deepseek.model).toContain('deepseek');
    expect(AI_PROVIDER_PRESETS.opencode.baseUrl).toContain('opencode.ai/inference/openai/v1');
    expect(AI_PROVIDER_PRESETS.opencode.style).toBe('openai');
  });
});

describe('AI provider responses', () => {
  test('parses OpenAI tool calls', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Moving the playhead.',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'seek', arguments: '{"time":2}' },
          }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const result = await callAiProvider({
        settings: baseSettings,
        apiKey: 'sk-test',
        system: 'system',
        messages: [{ role: 'user', content: 'Go to 2s' }],
        tools: [{ name: 'seek', description: 'Seek', parameters: { type: 'object', properties: {} } }],
      });
      expect(result.text).toBe('Moving the playhead.');
      expect(result.toolCalls[0]?.name).toBe('seek');
      expect(result.toolCalls[0]?.arguments.time).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('parses Anthropic tool_use blocks', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'Splitting the clip.' },
        { type: 'tool_use', id: 'tool-1', name: 'split_clip', input: { at: 3 } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const result = await callAiProvider({
        settings: { ...baseSettings, provider: 'anthropic', style: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
        apiKey: 'sk-ant-test',
        system: 'system',
        messages: [{ role: 'user', content: 'Split' }],
        tools: [{ name: 'split_clip', description: 'Split', parameters: { type: 'object', properties: {} } }],
      });
      expect(result.text).toBe('Splitting the clip.');
      expect(result.toolCalls[0]?.name).toBe('split_clip');
      expect(result.toolCalls[0]?.arguments.at).toBe(3);
    } finally {
      globalThis.fetch = original;
    }
  });
});
