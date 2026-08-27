import type { ThreadItem } from '@kodex/codex-protocol';
import { Bot, FileCode2, Globe2, Network, Search, SquareTerminal, Waypoints } from 'lucide-react';

function userText(item: Extract<ThreadItem, { type: 'userMessage' }>): string {
  return item.content.flatMap((entry) => 'text' in entry && typeof entry.text === 'string' ? [entry.text] : []).join('\n');
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ItemView({ item, liveText }: { item: ThreadItem; liveText?: string }) {
  switch (item.type) {
    case 'userMessage':
      return <article className="message user-message"><div className="message-avatar">You</div><div className="message-content"><p className="message-text">{userText(item)}</p></div></article>;
    case 'agentMessage':
      return <article className="message agent-message"><div className="message-avatar"><Bot size={14} /></div><div className="message-content"><p className="message-text">{liveText || item.text}</p></div></article>;
    case 'reasoning':
      return <div className="activity-card reasoning-card"><Waypoints size={14} /><div><strong>Reasoning</strong><p>{[...item.summary, ...item.content].join('\n')}</p></div></div>;
    case 'plan':
      return <div className="activity-card reasoning-card"><Waypoints size={14} /><div><strong>Plan</strong><p>{item.text}</p></div></div>;
    case 'commandExecution':
      return <div className="activity-card"><SquareTerminal size={14} /><div><strong>Command · {item.status}</strong><code>{item.command}</code>{item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}<span className={item.exitCode === 0 ? 'item-status is-success' : 'item-status'}>{item.exitCode == null ? 'running' : `exit ${item.exitCode}`}</span></div></div>;
    case 'fileChange':
      return <div className="activity-card"><FileCode2 size={14} /><div><strong>File change · {item.status}</strong><pre>{pretty(item.changes)}</pre></div></div>;
    case 'webSearch':
      return <div className="activity-card"><Search size={14} /><div><strong>Web Search</strong><p>{pretty(item.action)}</p></div></div>;
    case 'mcpToolCall':
      return <div className="activity-card"><Network size={14} /><div><strong>MCP · {item.server}/{item.tool}</strong><code>{pretty(item.arguments)}</code>{item.result && <pre>{pretty(item.result)}</pre>}<span className="item-status">{item.status}</span></div></div>;
    case 'dynamicToolCall':
      return <div className="activity-card"><Globe2 size={14} /><div><strong>Tool · {item.namespace ? `${item.namespace}/` : ''}{item.tool}</strong><code>{pretty(item.arguments)}</code><span className="item-status">{item.status}</span></div></div>;
    case 'collabAgentToolCall':
      return <div className="activity-card"><Waypoints size={14} /><div><strong>Agent coordination · {item.tool}</strong><p>{item.prompt ?? item.status}</p></div></div>;
    default:
      return <div className="activity-card compact-event"><FileCode2 size={13} /><div><strong>{item.type}</strong><span className="item-status">Codex event</span></div></div>;
  }
}
