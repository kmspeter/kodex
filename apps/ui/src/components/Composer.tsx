import type { GitStatus, KodexSettings } from '@kodex/kodex-api';
import type { Model, ReasoningEffort } from '@kodex/codex-protocol';
import { ArrowRight, Check, ChevronDown, GitBranch, LoaderCircle, Mic, ShieldCheck, WandSparkles, X } from 'lucide-react';
import { useState } from 'react';

export function Composer(props: {
  draft: string;
  busy: boolean;
  connected: boolean;
  engineReady: boolean;
  activeTurnId: string | null;
  models: Model[];
  model: string | null;
  effort: ReasoningEffort;
  settings: KodexSettings;
  git: GitStatus;
  onDraft: (draft: string) => void;
  onModel: (model: string, effort: ReasoningEffort) => void;
  onSend: () => void;
  onInterrupt: () => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const current = props.models.find((entry) => entry.model === props.model || entry.id === props.model);
  const disabled = !props.connected || !props.engineReady;
  return <div className="composer-wrap"><div className="composer">
    <textarea aria-label="Message" placeholder={disabled ? 'Configure OPENAI_API_KEY and build local Codex to start' : props.activeTurnId ? 'Steer the active turn' : 'Ask Kodex anything'} rows={2} value={props.draft} disabled={disabled} onChange={(event) => props.onDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onSend(); } }} />
    <div className="composer-footer"><div className="composer-left"><span className="composer-select"><ShieldCheck size={13} /> {props.settings.sandbox} · shell network {props.settings.network.shell ? 'on' : 'off'}</span><span className="composer-select branch-select"><GitBranch size={13} /> {props.git.branch || 'not a Git repository'}</span></div><div className="composer-right">
      <div className="menu-anchor"><button className="model-select" disabled={!props.models.length} onClick={() => setModelOpen((open) => !open)}>{current?.displayName || 'App Server default'} <span>{props.effort}</span> <ChevronDown size={11} /></button>{modelOpen && <div className="popover composer-popover model-popover">{props.models.map((entry) => <button key={entry.id} onClick={() => { props.onModel(entry.model, entry.defaultReasoningEffort); setModelOpen(false); }}><WandSparkles size={14} /> {entry.displayName} {entry.model === props.model && <Check size={13} />}</button>)}</div>}</div>
      <button className="icon-button" aria-label="Voice input unavailable" disabled title="Voice input is not exposed by this local UI"><Mic size={16} /></button>
      {props.activeTurnId ? <button className="send-button interrupt-button" aria-label="Interrupt turn" onClick={props.onInterrupt}><X size={15} /></button> : <button className="send-button" aria-label="Send message" onClick={props.onSend} disabled={!props.draft.trim() || props.busy || disabled}>{props.busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}</button>}
    </div></div>
  </div><p className="composer-note">{props.activeTurnId ? 'Send to steer · Stop interrupts the current turn' : 'Enter to send · Shift+Enter for a new line'}</p></div>;
}
