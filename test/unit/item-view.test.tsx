import type { ThreadItem } from '@kodex/codex-protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemView } from '../../apps/ui/src/components/ItemView';

const items = [
  {
    type: 'commandExecution', id: 'command-1', pluginId: null, scriptPath: null,
    command: 'npm test', cwd: 'D:/project', processId: null, source: 'agent', status: 'completed',
    commandActions: [], aggregatedOutput: '13 passed', exitCode: 0, durationMs: 10,
  },
  {
    type: 'fileChange', id: 'file-1', status: 'completed',
    changes: [{ path: 'src/main.ts', kind: { type: 'update', move_path: null }, diff: '+export {}' }],
  },
  {
    type: 'webSearch', id: 'web-1', query: 'Codex App Server',
    action: { type: 'search', query: 'Codex App Server', queries: ['Codex App Server'] }, results: [],
  },
  {
    type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', status: 'completed',
    arguments: { query: 'protocol' }, appContext: null, pluginId: null, readOnlyHint: true,
    result: { content: [{ type: 'text', text: 'found' }], structuredContent: null, _meta: null }, error: null, durationMs: 5,
  },
] satisfies ThreadItem[];

describe('typed activity item UI', () => {
  it('renders command, file change, web search, and MCP tool items from generated protocol types', () => {
    const markup = items.map((item) => renderToStaticMarkup(<ItemView item={item} />)).join('\n');
    expect(markup).toContain('Command · completed');
    expect(markup).toContain('13 passed');
    expect(markup).toContain('File change · completed');
    expect(markup).toContain('Web Search');
    expect(markup).toContain('MCP · docs/search');
  });
});
