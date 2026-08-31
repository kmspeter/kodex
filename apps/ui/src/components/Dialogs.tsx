import type { AppInfo, ConfigReadResponse, McpServerStatus, PluginListResponse, SkillsListEntry, Thread } from '@kodex/codex-protocol';
import type { AutomationRecord, BootstrapResponse, KodexSettings, ProjectRecord } from '@kodex/kodex-api';
import { ArchiveRestore, Box, Clock3, Network, Play, Plus, ShieldCheck, Trash2, WandSparkles, X } from 'lucide-react';
import { useState } from 'react';
import { KodexMark } from './Brand';

export type DialogName = 'automations' | 'skills' | 'archived' | 'settings' | null;

export function Dialogs(props: {
  dialog: DialogName;
  bootstrap: BootstrapResponse;
  automations: AutomationRecord[];
  skills: SkillsListEntry[];
  apps: AppInfo[];
  plugins: PluginListResponse | null;
  mcpServers: McpServerStatus[];
  archivedThreads: Thread[];
  codexConfig: ConfigReadResponse | null;
  onClose: () => void;
  onCreateAutomation: (input: { name: string; prompt: string; intervalMinutes: number }) => Promise<void>;
  onRunAutomation: (id: string) => Promise<void>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onSettings: (settings: Partial<KodexSettings>) => Promise<void>;
  onAddMcp: (name: string, url: string) => Promise<void>;
  onAddProject: (path: string, name?: string) => Promise<void>;
  onRemoveProject: (project: ProjectRecord) => Promise<void>;
  onUnarchive: (thread: Thread) => Promise<void>;
}) {
  if (!props.dialog) return null;
  return <div className="dialog-backdrop" onMouseDown={props.onClose}><section className={`app-dialog ${props.dialog === 'settings' ? 'settings-dialog' : ''}`} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <header className="dialog-header"><div className="dialog-title-lockup"><KodexMark compact /><div><span>Local Kodex workspace</span><h2>{props.dialog === 'automations' ? 'Automations' : props.dialog === 'skills' ? 'Skills & tools' : props.dialog === 'archived' ? 'Archived threads' : 'Settings'}</h2></div></div><button className="icon-button" aria-label="Close" onClick={props.onClose}><X size={16} /></button></header>
    {props.dialog === 'automations' && <AutomationDialog {...props} />}
    {props.dialog === 'skills' && <SkillsDialog skills={props.skills} apps={props.apps} plugins={props.plugins} mcpServers={props.mcpServers} />}
    {props.dialog === 'archived' && <ArchivedDialog threads={props.archivedThreads} onUnarchive={props.onUnarchive} />}
    {props.dialog === 'settings' && <SettingsDialog {...props} />}
  </section></div>;
}

function ArchivedDialog({ threads, onUnarchive }: { threads: Thread[]; onUnarchive: (thread: Thread) => Promise<void> }) {
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><ArchiveRestore size={20} /></div><div><h3>Official Codex archive</h3><p>Archived threads are read from and restored through App Server v2.</p></div></div>
    <div className="automation-list">{threads.map((thread) => <div className="automation-row" key={thread.id}><div><strong>{thread.name || thread.preview || thread.id}</strong><span>{thread.cwd}</span></div><button className="secondary-action" onClick={() => void onUnarchive(thread)}><ArchiveRestore size={12} /> Restore</button></div>)}{threads.length === 0 && <p className="dialog-empty">보관된 로컬 스레드가 없습니다.</p>}</div>
  </div>;
}

function AutomationDialog(props: Parameters<typeof Dialogs>[0]) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(60);
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><Clock3 size={20} /></div><div><h3>Local scheduler</h3><p>Prompts and schedules remain in `.kodex-data`; turns use the official App Server.</p></div></div>
    <div className="automation-form"><input placeholder="Automation name" value={name} onChange={(event) => setName(event.target.value)} /><textarea placeholder="Task prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><label>반복 간격 (분)<input type="number" min={1} max={10080} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><button className="primary-action" disabled={!prompt.trim()} onClick={() => void props.onCreateAutomation({ name, prompt, intervalMinutes: minutes }).then(() => { setName(''); setPrompt(''); })}><Plus size={13} /> Save automation</button></div>
    <div className="automation-list">{props.automations.map((entry) => <div className="automation-row" key={entry.id}><span className={`automation-status ${entry.enabled ? '' : 'paused'}`} /><div><strong>{entry.name}</strong><span>{entry.intervalMinutes}분마다 · {entry.lastStatus}</span>{entry.lastError && <span className="error-copy">{entry.lastError}</span>}</div><button className="secondary-action" onClick={() => void props.onRunAutomation(entry.id)}><Play size={12} /> Run</button><button className="icon-button" onClick={() => void props.onDeleteAutomation(entry.id)}><X size={13} /></button></div>)}{props.automations.length === 0 && <p className="dialog-empty">저장된 로컬 자동화가 없습니다.</p>}</div>
  </div>;
}

function SkillsDialog({ skills, apps, plugins, mcpServers }: { skills: SkillsListEntry[]; apps: AppInfo[]; plugins: PluginListResponse | null; mcpServers: McpServerStatus[] }) {
  const allSkills = skills.flatMap((entry) => entry.skills);
  return <div className="dialog-body"><div className="dialog-intro"><div className="dialog-icon"><WandSparkles size={20} /></div><div><h3>Official Codex integrations</h3><p>Inventory is read directly from App Server v2. Remote dependencies are not blanket-disabled.</p></div></div>
    <h4 className="dialog-section-title">Skills</h4><div className="skills-grid">{allSkills.map((skill) => <div className={`skill-card ${skill.enabled ? '' : 'is-disabled'}`} key={skill.path}><WandSparkles size={17} /><div><strong>{skill.name}</strong><span>{skill.description}</span><code>{skill.path}</code></div><span className={`status-pill ${skill.enabled ? '' : 'is-disabled'}`}>{skill.scope}</span></div>)}{allSkills.length === 0 && <p className="dialog-empty">App Server가 발견한 skill이 없습니다.</p>}</div>
    <h4 className="dialog-section-title">MCP servers</h4><div className="integration-list">{mcpServers.map((server) => <div className="integration-row" key={server.name}><Network size={15} /><div><strong>{server.name}</strong><span>{server.runtimeStatus ?? server.authStatus}</span></div><span className="status-pill">{Object.keys(server.tools).length} tools</span></div>)}{mcpServers.length === 0 && <p className="dialog-empty">Configured MCP server가 없습니다.</p>}</div>
    <h4 className="dialog-section-title">Apps & plugins</h4><div className="integration-list">{apps.map((app) => <div className="integration-row" key={app.id}><Box size={15} /><div><strong>{app.name}</strong><span>{app.description ?? 'Codex app'}</span></div><span className={`status-pill ${app.isAccessible && app.isEnabled ? '' : 'is-disabled'}`}>{app.isAccessible && app.isEnabled ? 'Available' : 'Unavailable'}</span></div>)}<div className="integration-row"><WandSparkles size={15} /><div><strong>Plugin marketplaces</strong><span>Official App Server response</span></div><span className="status-pill">{plugins?.marketplaces.length ?? 0}</span></div></div>
  </div>;
}

function SettingsDialog(props: Parameters<typeof Dialogs>[0]) {
  const [tab, setTab] = useState('General');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const settings = props.bootstrap.settings;
  const [providerMode, setProviderMode] = useState(settings.provider.mode);
  const [providerBaseUrl, setProviderBaseUrl] = useState(settings.provider.baseUrl);
  const [providerModel, setProviderModel] = useState(settings.provider.model);
  const tabs = ['General', 'Agent', 'Network & MCP', 'About Kodex'];
  const toggle = (patch: Partial<KodexSettings>) => void props.onSettings(patch);
  return <div className="settings-layout"><nav className="settings-nav">{tabs.map((name) => <button className={tab === name ? 'is-selected' : ''} key={name} onClick={() => setTab(name)}>{name}</button>)}</nav><div className="settings-content"><div className="settings-page-title"><h3>{tab}</h3><p>Kodex local host settings</p></div>
    {tab === 'General' && <><div className="setting-row"><div><strong>Workspace</strong><span>{props.bootstrap.activeProject.path}</span></div><span className="status-pill">Local</span></div><div className="setting-row"><div><strong>Storage</strong><span>.kodex-data · official CODEX_HOME format</span></div><span className="status-pill">Local</span></div><div className="setting-row"><div><strong>Sidebar</strong><span>Persisted by Local Server, not browser storage.</span></div><button className={`toggle-control ${settings.sidebarOpen ? 'is-on' : ''}`} onClick={() => toggle({ sidebarOpen: !settings.sidebarOpen })}><span /></button></div><h4 className="dialog-section-title">Local projects</h4><div className="integration-list">{props.bootstrap.projects.map((project) => <div className="integration-row" key={project.id}><Box size={15} /><div><strong>{project.name}</strong><span>{project.path}</span></div>{props.bootstrap.projects.length > 1 && <button className="icon-button" aria-label={`Remove ${project.name}`} onClick={() => void props.onRemoveProject(project)}><Trash2 size={13} /></button>}</div>)}</div><div className="mcp-form"><input placeholder="D:\\absolute\\project\\path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /><input placeholder="Optional display name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><button className="primary-action" disabled={!projectPath.trim()} onClick={() => void props.onAddProject(projectPath, projectName || undefined).then(() => { setProjectPath(''); setProjectName(''); })}><Plus size={13} /> Add project</button></div></>}
    {tab === 'Agent' && <>
      <div className="setting-row"><div><strong>Codex source build</strong><span>{props.bootstrap.engine.version ?? props.bootstrap.engine.binary ?? 'Run npm run codex:build'}</span></div><span className="status-pill">{props.bootstrap.engine.binarySource ?? 'missing'}</span></div>
      <div className="setting-row"><div><strong>Official config</strong><span>{props.codexConfig ? `${props.codexConfig.layers?.length ?? 0} layers read for this workspace` : 'Unavailable until App Server is connected'}</span></div><span className="status-pill">App Server v2</span></div>
      <div className="setting-row"><div><strong>Model provider</strong><span>OpenAI uses `OPENAI_API_KEY`; local mode accepts only a loopback Responses API endpoint.</span></div><select value={providerMode} onChange={(event) => setProviderMode(event.target.value as KodexSettings['provider']['mode'])}><option value="openai">OpenAI</option><option value="local">OpenAI-compatible local</option></select></div>
      {providerMode === 'local' && <div className="mcp-form"><input aria-label="Local Responses API base URL" placeholder="http://127.0.0.1:8080/v1" value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} /><input aria-label="Local model name" placeholder="local-model-name" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} /><span>The pinned Codex build supports the Responses wire API only. Tool calling and streaming must be implemented by the local server.</span></div>}
      {providerMode === 'openai' && <div className="mcp-form"><input aria-label="Optional OpenAI model override" placeholder="Leave blank for App Server default" value={providerModel} onChange={(event) => setProviderModel(event.target.value)} /><span>The official OpenAI endpoint is selected by Codex; custom remote base URLs are not accepted here.</span></div>}
      <button className="primary-action" disabled={providerMode === 'local' && (!providerBaseUrl.trim() || !providerModel.trim())} onClick={() => void props.onSettings({ provider: { mode: providerMode, baseUrl: providerMode === 'local' ? providerBaseUrl.trim() : '', model: providerModel.trim() } })}>Apply provider and restart App Server</button>
      <div className="setting-row"><div><strong>Sandbox</strong><span>Applied through official thread/turn parameters.</span></div><select value={settings.sandbox} onChange={(event) => toggle({ sandbox: event.target.value as KodexSettings['sandbox'] })}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></select></div>
      <div className="setting-row"><div><strong>Approval policy</strong><span>Official App Server approval requests are shown in the conversation.</span></div><select value={settings.approvalPolicy} onChange={(event) => toggle({ approvalPolicy: event.target.value as KodexSettings['approvalPolicy'] })}><option value="untrusted">untrusted</option><option value="on-request">on-request</option><option value="never">never</option></select></div>
    </>}
    {tab === 'Network & MCP' && <><div className="setting-row"><div><strong>Shell network</strong><span>Controls `SandboxPolicy.networkAccess` for workspace/read-only turns.</span></div><button className={`toggle-control ${settings.network.shell ? 'is-on' : ''}`} onClick={() => toggle({ network: { ...settings.network, shell: !settings.network.shell } })}><span /></button></div><div className="setting-row"><div><strong>Web Search</strong><span>Uses official `web_search` mode, separate from shell networking.</span></div><button className={`toggle-control ${settings.network.webSearch ? 'is-on' : ''}`} onClick={() => toggle({ network: { ...settings.network, webSearch: !settings.network.webSearch } })}><span /></button></div><div className="setting-row"><div><strong>Remote MCP</strong><span>Configured in Kodex CODEX_HOME and authenticated through local environment variables.</span></div><span className="status-pill">Official config</span></div><div className="mcp-form"><input placeholder="server-name" value={mcpName} onChange={(event) => setMcpName(event.target.value)} /><input placeholder="https://example.com/mcp" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} /><button className="primary-action" disabled={!mcpName.trim() || !mcpUrl.trim()} onClick={() => void props.onAddMcp(mcpName, mcpUrl).then(() => { setMcpName(''); setMcpUrl(''); })}><Plus size={13} /> Add remote MCP</button><span>Secrets are not entered here. Reference environment variables in official Codex config when authentication is needed.</span></div></>}
    {tab === 'About Kodex' && <div className="about-kodex"><KodexMark /><h3>Kodex</h3><p>Local UI + Local Server + official Codex App Server</p><span>API-key authentication · local application state · network-capable tools under official sandbox and approvals</span><div className="about-details"><ShieldCheck size={15} /> The browser never receives `OPENAI_API_KEY`.</div></div>}
  </div></div>;
}
