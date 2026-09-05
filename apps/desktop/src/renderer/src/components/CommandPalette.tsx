import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bot, Search } from 'lucide-react';
import { useNavigate } from '../lib/router';
import type { CommandResultMap } from '../../../shared/contracts';
import { useWorkspace } from '../state/WorkspaceContext';
import { Dialog, EmptyState } from './ui';

type SearchResult = CommandResultMap['search'][number];

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { command } = useWorkspace();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setResults([]);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void command('search', { query: query.trim() })
        .then((items) => {
          if (!cancelled) setResults(items);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [command, open, query]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Search Outreachr"
      description="Find any investor, person, task, meeting, or company fact."
    >
      <div className="palette-search">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try “AI seed investors in New York”"
          aria-label="Search query"
        />
        {loading ? <span className="palette-search__status">Searching…</span> : null}
      </div>
      {query.trim().length < 2 ? (
        <div className="palette-shortcuts">
          <button
            onClick={() => {
              navigate('/agent');
              onClose();
            }}
          >
            <Bot aria-hidden="true" />
            <span>
              <strong>Ask the agent</strong>
              <small>Research, compare, summarize, or prepare a proposal.</small>
            </span>
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            onClick={() => {
              navigate('/investors');
              onClose();
            }}
          >
            <Search aria-hidden="true" />
            <span>
              <strong>Browse the investor universe</strong>
              <small>Filter by stage, check, sector, location, and evidence.</small>
            </span>
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      ) : loading ? (
        <div className="palette-loading" role="status">
          Searching local records…
        </div>
      ) : results.length ? (
        <ul className="palette-results" aria-label="Search results">
          {results.map((result) => (
            <li key={`${result.kind}-${result.id}`}>
              <button
                onClick={() => {
                  void navigate(result.href);
                  onClose();
                }}
              >
                <span className="palette-results__kind">{result.kind}</span>
                <span>
                  <strong>{result.title}</strong>
                  <small>{result.subtitle}</small>
                </span>
                <ArrowRight aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No matching records"
          detail="Try a firm name, partner, sector, task, or meeting."
        />
      )}
    </Dialog>
  );
}
