import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type {
  AppBootstrap,
  CommandMap,
  CommandResultMap,
  InvestorDetail,
} from '../../../shared/contracts';

interface ToastMessage {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}

interface WorkspaceValue {
  data: AppBootstrap | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  toasts: ToastMessage[];
  refresh: () => Promise<void>;
  command: <K extends keyof CommandMap>(
    name: K,
    payload: CommandMap[K],
  ) => Promise<CommandResultMap[K]>;
  getInvestor: (id: string) => Promise<InvestorDetail>;
  notify: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
const reportedCommandFailures = new WeakSet<object>();

function objectReason(reason: unknown): object | null {
  return (typeof reason === 'object' && reason !== null) || typeof reason === 'function'
    ? reason
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export function WorkspaceProvider({
  children,
  streamingAgent = false,
}: PropsWithChildren<{ streamingAgent?: boolean }>): React.JSX.Element {
  const [data, setData] = useState<AppBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const notify = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      const reason = objectReason(event.reason);
      if (reason && reportedCommandFailures.has(reason)) return;
      notify({
        tone: 'error',
        title: 'Action could not be completed',
        detail: errorMessage(event.reason),
      });
    };
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  }, [notify]);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);

    try {
      const bootstrap = await window.outreachr.bootstrap();
      setData(bootstrap);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const command = useCallback(
    async <K extends keyof CommandMap>(name: K, payload: CommandMap[K]) => {
      try {
        const result = await window.outreachr.command(name, payload);
        if (
          name === 'onboarding.complete' ||
          name === 'investor.target' ||
          name === 'pipeline.move' ||
          name === 'backup.restore'
        ) {
          setData(result as AppBootstrap);
        } else if (
          name.startsWith('task.') ||
          name.startsWith('meeting.') ||
          name.startsWith('draft.') ||
          name.startsWith('source.') ||
          name.startsWith('investor.') ||
          name.startsWith('pipeline.') ||
          name.startsWith('round.') ||
          name.startsWith('list.') ||
          name.startsWith('connector.') ||
          name.startsWith('mail.') ||
          name.startsWith('communications.') ||
          name.startsWith('suppression.') ||
          name.startsWith('person.') ||
          (name.startsWith('agent.') &&
            !(streamingAgent && ['agent.run', 'agent.cancel'].includes(name))) ||
          name.startsWith('knowledge.') ||
          name === 'data.importInvestorCsv'
        ) {
          await load(true);
        }
        return result;
      } catch (cause) {
        const message = errorMessage(cause);
        const reason = objectReason(cause);
        if (reason) reportedCommandFailures.add(reason);
        notify({ tone: 'error', title: 'Action could not be completed', detail: message });
        throw cause;
      }
    },
    [load, notify, streamingAgent],
  );

  const getInvestor = useCallback((id: string) => command('investor.get', { id }), [command]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      data,
      loading,
      error,
      refreshing,
      toasts,
      refresh,
      command,
      getInvestor,
      notify,
      dismissToast,
    }),
    [data, dismissToast, error, getInvestor, loading, notify, refresh, refreshing, toasts, command],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
