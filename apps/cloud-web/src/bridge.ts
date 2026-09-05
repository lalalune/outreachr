/** Adapts the existing CRM interface to authenticated workspace HTTP operations. */
import type {
  AgentEvent,
  OutreachrBridge,
  CommandResultMap,
} from '../../desktop/src/shared/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'X-Outreachr-Request': '1',
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error ?? 'The request failed.', response.status);
  return result;
}
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

export function createBridge(orgId: string): OutreachrBridge {
  const base = `/api/organizations/${encodeURIComponent(orgId)}`;
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => listeners.forEach((listener) => listener(event));
  function run(payload: unknown): Promise<CommandResultMap['agent.run']> {
    return new Promise((resolve, reject) => {
      let acknowledged = false;
      let runId = '';
      let terminal = false;
      void (async () => {
        const response = await fetch(`${base}/commands`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Outreachr-Request': '1' },
          body: JSON.stringify({ name: 'agent.run', payload }),
        });
        if (!response.ok || !response.body)
          throw new Error(
            ((await response.json()) as { error?: string }).error ?? 'The AI request failed.',
          );
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          if (buffer.length > 2_000_000) {
            await reader.cancel();
            throw new Error('AI response exceeded its size limit.');
          }
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const item = JSON.parse(line) as {
              event?: AgentEvent;
              result?: { runId: string };
              error?: string;
            };
            if (item.error) throw new Error(item.error);
            if (item.event) {
              runId = item.event.runId;
              if (!acknowledged) {
                acknowledged = true;
                resolve({ runId });
                // Let the command caller record runId before a fast terminal event arrives.
                await new Promise((done) => setTimeout(done, 0));
              }
              terminal ||= item.event.type === 'completed' || item.event.type === 'error';
              emit(item.event);
            }
            if (item.result && !acknowledged) {
              acknowledged = true;
              resolve(item.result);
            }
          }
          if (next.done) break;
        }
        if (!terminal)
          throw new Error(
            'The connection ended before the AI request completed. Refresh the workspace to check its recorded result.',
          );
      })().catch((error: unknown) => {
        if (!acknowledged) reject(error instanceof Error ? error : new Error('AI request failed.'));
        else
          emit({
            runId,
            type: 'error',
            text: error instanceof Error ? error.message : 'AI connection failed.',
          });
      });
    });
  }
  const download = async (value: string) => {
    const handle = value.replace(/^file:\/\//, '');
    if (!/^cloud-file:[0-9a-f-]{36}$/.test(handle))
      throw new Error('This file is not stored in this cloud workspace.');
    const response = await fetch(`${base}/files/${handle.slice(11)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('This file is no longer available.');
    const name =
      response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'download';
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return {
    bootstrap: () => api(`${base}/bootstrap`),
    command: async (name, payload) =>
      (name === 'agent.run'
        ? run(payload)
        : post(`${base}/commands`, { name, payload })) as Promise<never>,
    selectFile: (filters) =>
      new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept =
          filters
            ?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`))
            .join(',') ?? '';
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.addEventListener(
          'change',
          () => {
            const file = input.files?.[0];
            if (!file) {
              resolve(null);
              return;
            }
            if (file.size > 25 * 1024 * 1024) {
              reject(new Error('Files must be 25 MB or smaller.'));
              return;
            }
            void api<{ path: string }>(`${base}/files`, {
              method: 'POST',
              body: file,
              headers: { 'X-File-Name': file.name.replace(/[^a-zA-Z0-9 ._()-]/g, '_') },
            }).then((result) => resolve(result.path), reject);
          },
          { once: true },
        );
        input.click();
      }),
    selectDirectory: async () => 'cloud-downloads',
    openExternal: async (value) => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Only secure external links are supported.');
      window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    revealPath: download,
    copyText: (text) => navigator.clipboard.writeText(text),
    openLegal: async (document) => {
      window.open(`/legal/${document}.txt`, '_blank', 'noopener,noreferrer');
    },
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
