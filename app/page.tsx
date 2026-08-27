"use client";

import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  ChevronDown,
  CircleDot,
  Clock3,
  Code2,
  Columns2,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  History,
  LayoutGrid,
  Mic,
  MoreHorizontal,
  PanelLeftClose,
  Play,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  WandSparkles,
  X,
} from 'lucide-react';

const recentThreads = [
  { title: 'Polish the settings panel', meta: '2m' },
  { title: 'Refactor the activity feed', meta: '18m' },
  { title: 'Fix command palette focus', meta: '1h' },
];

const projects = [
  { name: 'design-system', active: true },
  { name: 'storefront', active: false },
  { name: 'api-service', active: false },
];

function SidebarItem({
  icon,
  children,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`sidebar-item ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      <span className="sidebar-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialog, setDialog] = useState<'automations' | 'skills' | 'settings' | null>(null);
  const [activeThread, setActiveThread] = useState(recentThreads[0].title);
  const [activeProject, setActiveProject] = useState(projects[0].name);
  const [draft, setDraft] = useState('');
  const [userPrompt, setUserPrompt] = useState(
    'Make the settings panel feel native to the desktop app. Keep the content unchanged, tighten the spacing, and make sure the layout still works at smaller window sizes.',
  );
  const isNewThread = activeThread === 'New thread';

  const sendDraft = () => {
    const nextPrompt = draft.trim();
    if (!nextPrompt) return;
    setUserPrompt(nextPrompt);
    setActiveThread(
      nextPrompt.length > 42 ? `${nextPrompt.slice(0, 42)}…` : nextPrompt,
    );
    setDraft('');
  };

  return (
    <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <div className="window-row">
          <div className="window-nav">
            <button className="icon-button" aria-label="Go back">
              <ArrowLeft size={15} />
            </button>
            <button className="icon-button is-muted" aria-label="Go forward">
              <ArrowRight size={15} />
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Toggle sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Workspace navigation">
          <SidebarItem
            icon={<Plus size={16} />}
            active={isNewThread}
            onClick={() => setActiveThread('New thread')}
          >
            New thread
          </SidebarItem>
          <SidebarItem icon={<Clock3 size={15} />} onClick={() => setDialog('automations')}>
            Automations
          </SidebarItem>
          <SidebarItem icon={<WandSparkles size={15} />} onClick={() => setDialog('skills')}>
            Skills
          </SidebarItem>
        </nav>

        <div className="sidebar-section">
          <div className="section-heading">
            <span>Threads</span>
            <button className="icon-button tiny" aria-label="Search threads">
              <Search size={13} />
            </button>
          </div>
          <div className="thread-list">
            {recentThreads.map((thread) => (
              <button
                className={`thread-row ${activeThread === thread.title ? 'is-current' : ''}`}
                key={thread.title}
                onClick={() => setActiveThread(thread.title)}
              >
                <span className="thread-copy">
                  <span className="thread-title">{thread.title}</span>
                  <span className="thread-project">design-system</span>
                </span>
                <span className="thread-time">{thread.meta}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-section projects-section">
          <div className="section-heading">
            <span>Projects</span>
            <button className="icon-button tiny" aria-label="Add project">
              <Plus size={13} />
            </button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <button
                className={`project-row ${activeProject === project.name ? 'is-current' : ''}`}
                key={project.name}
                onClick={() => setActiveProject(project.name)}
              >
                <Box size={14} strokeWidth={1.8} />
                <span>{project.name}</span>
                {activeProject === project.name && <CircleDot className="project-dot" size={11} />}
              </button>
            ))}
          </div>
        </div>

        <button className="sidebar-settings" onClick={() => setDialog('settings')}>
          <Settings size={15} />
          <span>Settings</span>
        </button>
      </aside>

      <section className={`workspace ${detailsOpen ? 'has-details' : ''}`}>
        <header className="workspace-header">
          <div className="title-group">
            {!sidebarOpen && (
              <button
                className="icon-button reopen-sidebar"
                aria-label="Open sidebar"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftClose size={15} className="flip-x" />
              </button>
            )}
            <h1>{activeThread}</h1>
            <button className="project-switcher">
              {activeProject} <ChevronDown size={12} />
            </button>
          </div>

          <div className="header-actions">
            <button className="toolbar-button">
              <Code2 size={14} />
              <span>Open</span>
              <ChevronDown size={11} />
            </button>
            <button className="toolbar-button">
              <Play size={13} fill="currentColor" />
              <span>Hand off</span>
            </button>
            <button
              className="toolbar-button change-button"
              onClick={() => setDetailsOpen(true)}
            >
              <GitCommitHorizontal size={14} />
              <span>Review changes</span>
              <span className="change-count plus">+184</span>
              <span className="change-count minus">−27</span>
            </button>
            <button
              className="icon-button bordered"
              aria-label="Open thread details"
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <Columns2 size={15} />
            </button>
            <button className="icon-button" aria-label="More actions">
              <MoreHorizontal size={17} />
            </button>
          </div>
        </header>

        <div className="conversation-scroll">
          <article className="conversation">
            {isNewThread ? (
              <div className="empty-thread">
                <div className="empty-thread-icon">
                  <Sparkles size={18} />
                </div>
                <h2>What would you like to build?</h2>
                <p>
                  Describe a task, ask about the codebase, or start with one of
                  the suggestions below.
                </p>
                <div className="suggestion-grid">
                  <button onClick={() => setDraft('Explain this codebase and its main architecture')}>
                    <Code2 size={14} /> Explain this codebase
                  </button>
                  <button onClick={() => setDraft('Review the current changes for bugs')}>
                    <GitCommitHorizontal size={14} /> Review current changes
                  </button>
                </div>
              </div>
            ) : (
              <>
            <div className="user-message">
              <p>{userPrompt}</p>
            </div>

            <div className="assistant-block">
              <div className="assistant-avatar" aria-hidden="true">
                <Sparkles size={14} />
              </div>
              <div className="assistant-content">
                <p>
                  I’ll inspect the current panel structure and its responsive
                  rules first, then update the smallest set of components and
                  verify the result at desktop and compact widths.
                </p>

                <div className="activity-stack">
                  <div className="activity-row">
                    <SquareTerminal size={14} />
                    <span>Ran</span>
                    <code>rg --files src/components/settings</code>
                    <span className="activity-time">for 0.2s</span>
                  </div>
                  <div className="activity-row">
                    <FileCode2 size={14} />
                    <span>Read</span>
                    <code>SettingsPanel.tsx</code>
                    <span className="activity-detail">242 lines</span>
                  </div>
                  <div className="activity-row">
                    <FileCode2 size={14} />
                    <span>Read</span>
                    <code>settings-panel.css</code>
                    <span className="activity-detail">186 lines</span>
                  </div>
                </div>

                <p>
                  The panel is using fixed section padding and a minimum width
                  that forces the footer controls to wrap. I’m consolidating
                  those values into the existing responsive layer now.
                </p>

                <div className="edit-card">
                  <div className="edit-card-top">
                    <div>
                      <FileCode2 size={14} />
                      <span>Edited</span>
                      <strong>SettingsPanel.tsx</strong>
                    </div>
                    <span className="diff-summary">
                      <b>+31</b> <em>−18</em>
                    </span>
                  </div>
                  <div className="code-preview" aria-hidden="true">
                    <span className="line-no">88</span>
                    <span className="code-line removed">padding: 24px 28px;</span>
                    <span className="line-no">88</span>
                    <span className="code-line added">padding: 20px 22px;</span>
                    <span className="line-no">89</span>
                    <span className="code-line added">min-width: 0;</span>
                  </div>
                </div>

                <div className="activity-row single">
                  <SquareTerminal size={14} />
                  <span>Ran</span>
                  <code>npm run test -- settings-panel</code>
                  <span className="success-status">Passed</span>
                  <span className="activity-time">for 5.8s</span>
                </div>

                <div className="worked-line">
                  <span>Worked for 4m 12s</span>
                </div>

                <p>
                  The settings panel now matches the desktop spacing and scales
                  cleanly at narrow widths. Section padding, control heights,
                  dividers, and footer alignment were normalized without
                  changing any settings behavior.
                </p>
                <p>
                  The focused settings test passed, and the compact layout no
                  longer introduces horizontal overflow.
                </p>

                <div className="result-actions">
                  <button>
                    <History size={13} /> Undo
                  </button>
                  <button>
                    <GitBranch size={13} /> View changes
                  </button>
                </div>
              </div>
            </div>
              </>
            )}
          </article>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              aria-label="Message"
              placeholder="Ask for follow-up changes"
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
            />
            <div className="composer-footer">
              <div className="composer-left">
                <button className="icon-button composer-add" aria-label="Add context">
                  <Plus size={17} />
                </button>
                <button className="composer-select">
                  <LayoutGrid size={13} /> Local <ChevronDown size={11} />
                </button>
                <button className="composer-select">
                  <SlidersHorizontal size={13} /> Default permissions
                  <ChevronDown size={11} />
                </button>
                <button className="composer-select branch-select">
                  <GitBranch size={13} /> main
                </button>
              </div>
              <div className="composer-right">
                <button className="model-select">
                  5.6 Sol <span>High</span> <ChevronDown size={11} />
                </button>
                <button className="icon-button" aria-label="Voice input">
                  <Mic size={16} />
                </button>
                <button
                  className="send-button"
                  aria-label="Send message"
                  onClick={sendDraft}
                  disabled={!draft.trim()}
                >
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>
          </div>
          <p className="composer-note">Enter to send · Shift+Enter for a new line</p>
        </div>

        {detailsOpen && (
          <aside className="detail-panel" aria-label="Thread changes">
            <div className="detail-header">
              <div>
                <strong>Changes</strong>
                <span>design-system</span>
              </div>
              <button
                className="icon-button"
                aria-label="Close thread details"
                onClick={() => setDetailsOpen(false)}
              >
                <X size={15} />
              </button>
            </div>

            <div className="change-overview">
              <div className="change-overview-top">
                <span>4 files changed</span>
                <span className="diff-summary">
                  <b>+184</b> <em>−27</em>
                </span>
              </div>
              <div className="diff-bar" aria-hidden="true">
                <span className="added-bar" />
                <span className="removed-bar" />
              </div>
            </div>

            <div className="file-change-list">
              {[
                ['SettingsPanel.tsx', '+31', '−18'],
                ['settings-panel.css', '+92', '−9'],
                ['SettingsSection.tsx', '+44', '−0'],
                ['settings-panel.test.tsx', '+17', '−0'],
              ].map(([file, added, removed], index) => (
                <button className={`file-change ${index === 0 ? 'is-selected' : ''}`} key={file}>
                  <FileCode2 size={14} />
                  <span>{file}</span>
                  <b>{added}</b>
                  <em>{removed}</em>
                </button>
              ))}
            </div>

            <div className="detail-bottom">
              <div className="branch-card">
                <GitBranch size={14} />
                <div>
                  <span>Current branch</span>
                  <strong>main</strong>
                </div>
              </div>
              <button className="primary-action">Review all changes</button>
            </div>
          </aside>
        )}
      </section>

      {dialog && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <section
            className="app-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${dialog} panel`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <div>
                <span>{dialog === 'settings' ? 'Preferences' : 'Workspace'}</span>
                <h2>
                  {dialog === 'automations'
                    ? 'Automations'
                    : dialog === 'skills'
                      ? 'Skills'
                      : 'Settings'}
                </h2>
              </div>
              <button className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}>
                <X size={16} />
              </button>
            </header>

            {dialog === 'automations' && (
              <div className="dialog-body empty-dialog">
                <Clock3 size={23} />
                <h3>Schedule recurring work</h3>
                <p>Create tasks that run on a schedule and keep their results in this workspace.</p>
                <button className="primary-action">New automation</button>
              </div>
            )}

            {dialog === 'skills' && (
              <div className="dialog-body">
                <div className="dialog-list-row">
                  <WandSparkles size={17} />
                  <div><strong>Interface review</strong><span>Checks spacing, hierarchy, and accessibility.</span></div>
                  <span className="status-pill">Ready</span>
                </div>
                <div className="dialog-list-row">
                  <Code2 size={17} />
                  <div><strong>Frontend workflow</strong><span>Builds and verifies focused UI changes.</span></div>
                  <span className="status-pill">Ready</span>
                </div>
                <button className="secondary-action">Browse skills</button>
              </div>
            )}

            {dialog === 'settings' && (
              <div className="settings-layout">
                <nav className="settings-nav">
                  <button className="is-selected">General</button>
                  <button>Appearance</button>
                  <button>Agent</button>
                  <button>Integrations</button>
                </nav>
                <div className="settings-content">
                  <div className="setting-row">
                    <div><strong>Preferred editor</strong><span>Choose where files open from a thread.</span></div>
                    <button className="select-control">Visual Studio Code <ChevronDown size={12} /></button>
                  </div>
                  <div className="setting-row">
                    <div><strong>Integrated terminal</strong><span>Used for new terminal sessions.</span></div>
                    <button className="select-control">PowerShell <ChevronDown size={12} /></button>
                  </div>
                  <div className="setting-row">
                    <div><strong>Thread detail</strong><span>Choose how much command output to show.</span></div>
                    <button className="select-control">Standard <ChevronDown size={12} /></button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
