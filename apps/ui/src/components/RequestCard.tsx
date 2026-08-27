import { useState } from 'react';
import type { ServerRequest } from '@kodex/codex-protocol';
import { AlertTriangle } from 'lucide-react';

function requestSummary(request: ServerRequest): { title: string; detail: string; command?: string } {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      return { title: 'Command approval', detail: request.params.reason ?? 'Codex requests permission to run this command.', command: request.params.command ?? undefined };
    case 'item/fileChange/requestApproval':
      return { title: 'File change approval', detail: request.params.reason ?? `Codex requests write access${request.params.grantRoot ? ` under ${request.params.grantRoot}` : ''}.` };
    case 'item/permissions/requestApproval':
      return { title: 'Permission request', detail: request.params.reason ?? JSON.stringify(request.params.permissions) };
    case 'item/tool/requestUserInput':
      return { title: 'Codex needs input', detail: request.params.questions.map((question) => question.question).join('\n') };
    case 'mcpServer/elicitation/request':
      return { title: `MCP input · ${request.params.serverName}`, detail: request.params.message };
    case 'item/tool/call':
      return { title: 'Dynamic tool request', detail: `${request.params.tool}` };
    default:
      return { title: request.method, detail: 'This request is not supported by the Kodex host.' };
  }
}

export function RequestCard({ request, onResolve, onError }: {
  request: ServerRequest;
  onResolve: (id: string | number, result: unknown) => void;
  onError: (id: string | number, message: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const summary = requestSummary(request);

  function accept(): void {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        onResolve(request.id, { decision: 'accept' });
        return;
      case 'item/permissions/requestApproval':
        onResolve(request.id, {
          permissions: {
            ...(request.params.permissions.network ? { network: request.params.permissions.network } : {}),
            ...(request.params.permissions.fileSystem ? { fileSystem: request.params.permissions.fileSystem } : {}),
          },
          scope: 'turn',
        });
        return;
      case 'item/tool/requestUserInput':
        onResolve(request.id, { answers: Object.fromEntries(request.params.questions.map((question) => [question.id, { answers: [answers[question.id] ?? ''] }])) });
        return;
      case 'mcpServer/elicitation/request':
        onResolve(request.id, { action: 'accept', content: answers.content ? JSON.parse(answers.content) as unknown : {}, _meta: null });
        return;
      default:
        onError(request.id, 'Kodex does not implement this host-side request.');
    }
  }

  function decline(): void {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        onResolve(request.id, { decision: 'decline' });
        return;
      case 'item/permissions/requestApproval':
        onResolve(request.id, { permissions: {}, scope: 'turn' });
        return;
      case 'item/tool/requestUserInput':
        onResolve(request.id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        onResolve(request.id, { action: 'decline', content: null, _meta: null });
        return;
      default:
        onError(request.id, 'User declined the request.');
    }
  }

  return <section className="approval-card">
    <div className="approval-title"><AlertTriangle size={15} /><div><strong>{summary.title}</strong><span>{summary.detail}</span></div></div>
    {summary.command && <code>{summary.command}</code>}
    {request.method === 'item/tool/requestUserInput' && request.params.questions.map((question) => <label className="request-input" key={question.id}><span>{question.header}</span>{question.options ? <select value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">Select…</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}</select> : <input type={question.isSecret ? 'password' : 'text'} value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}
    {request.method === 'mcpServer/elicitation/request' && <label className="request-input"><span>Structured JSON response</span><textarea value={answers.content ?? '{}'} onChange={(event) => setAnswers({ content: event.target.value })} /></label>}
    <div className="approval-actions"><button className="secondary-action" onClick={decline}>Decline</button><button className="primary-action" onClick={() => { try { accept(); } catch { onError(request.id, 'The response must be valid JSON.'); } }}>Approve once</button></div>
  </section>;
}
