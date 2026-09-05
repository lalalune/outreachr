import { Download, Filter, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from '../lib/router';
import { InvestorTable } from '../components/InvestorTable';
import { InvestorCsvImportButton } from '../components/InvestorCsvImportButton';
import type { InvestorKind } from '../../../shared/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  SearchField,
  TextField,
  titleCase,
} from '../components/ui';
import { filterInvestorsByMemberIds } from '../lib/investor-lists';
import { isSecureExternalUrl } from '../lib/external-links';
import { useWorkspace } from '../state/WorkspaceContext';

type View = 'firms' | 'people' | 'portfolio';
const INVESTOR_VIEWS: readonly View[] = ['firms', 'people', 'portfolio'];

export function InvestorsPage(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<View>('firms');
  const [query, setQuery] = useState('');
  const [targetOnly, setTargetOnly] = useState(false);
  const [minimumFit, setMinimumFit] = useState(0);
  const [investorKind, setInvestorKind] = useState<InvestorKind | 'all'>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<InvestorKind>('venture_capital');
  const [website, setWebsite] = useState('');
  const [headquarters, setHeadquarters] = useState('');
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const requestedListId = searchParams.get('list');
  const selectedList = data?.lists.find((list) => list.id === requestedListId) ?? null;
  const normalizedWebsite = website.trim();
  const websiteError =
    normalizedWebsite && !isSecureExternalUrl(normalizedWebsite)
      ? 'Use a complete, credential-free HTTPS URL.'
      : undefined;

  const listInvestors = useMemo(() => {
    const investors = data?.investors ?? [];
    if (selectedList) return filterInvestorsByMemberIds(investors, selectedList.memberFirmIds);
    return requestedListId ? [] : investors;
  }, [data?.investors, requestedListId, selectedList]);

  const availableKinds = useMemo(
    () =>
      [
        ...new Set(
          listInvestors.flatMap((investor) => [investor.kind, ...investor.additionalKinds]),
        ),
      ]
        .filter((value): value is InvestorKind => Boolean(value))
        .sort((left, right) => titleCase(left).localeCompare(titleCase(right))),
    [listInvestors],
  );

  useEffect(() => {
    if (investorKind !== 'all' && !availableKinds.includes(investorKind)) {
      setInvestorKind('all');
    }
  }, [availableKinds, investorKind]);

  const filteredInvestors = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return listInvestors
      .filter((investor) => !targetOnly || investor.target)
      .filter((investor) => investor.fitScore >= minimumFit)
      .filter(
        (investor) =>
          investorKind === 'all' ||
          investor.kind === investorKind ||
          investor.additionalKinds.includes(investorKind),
      )
      .filter((investor) => {
        if (!normalized) return true;
        const kinds = [investor.kind, ...investor.additionalKinds];
        return [
          investor.name,
          investor.headquarters,
          ...kinds,
          ...kinds.map(titleCase),
          ...investor.sectors,
          ...investor.stages,
          ...investor.geographies,
        ]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      })
      .sort((a, b) => b.fitScore - a.fitScore || a.name.localeCompare(b.name));
  }, [investorKind, listInvestors, minimumFit, query, targetOnly]);

  const filteredPeople = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const memberFirmIds = selectedList ? new Set(selectedList.memberFirmIds) : null;
    return (data?.people ?? [])
      .filter((person) => {
        if (!requestedListId) return true;
        return memberFirmIds?.has(person.firmId ?? '') ?? false;
      })
      .filter((person) => {
        if (!normalized) return true;
        return [person.name, person.firmName, person.title, ...person.sectors]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalized));
      });
  }, [data?.people, query, requestedListId, selectedList]);

  const portfolioInvestors = useMemo(
    () => filteredInvestors.filter((investor) => investor.portfolioCount > 0),
    [filteredInvestors],
  );

  if (!data) return <></>;

  const exportData = async (): Promise<void> => {
    setExporting(true);
    try {
      const directory = await window.outreachr.selectDirectory();
      if (!directory) return;
      const result = await command('data.exportCsv', {
        directory,
        kind: view === 'people' ? 'people' : 'investors',
      });
      notify({ tone: 'success', title: 'Export created', detail: result.path });
    } finally {
      setExporting(false);
    }
  };

  const addInvestor = async (): Promise<void> => {
    if (!name.trim() || websiteError) return;
    setAdding(true);
    try {
      const created = await command('investor.create', {
        name: name.trim(),
        kind,
        ...(normalizedWebsite ? { website: normalizedWebsite } : {}),
        ...(headquarters.trim() ? { headquarters: headquarters.trim() } : {}),
      });
      setAddOpen(false);
      setName('');
      setKind('venture_capital');
      setWebsite('');
      setHeadquarters('');
      notify({
        tone: 'success',
        title: 'Investor added',
        detail: `${created.name} remains private until explicitly marked contribution-eligible.`,
      });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page page--wide">
      <PageHeader
        title="Investor universe"
        description="Evidence-backed firms, partners, angels, scouts, and sourced portfolio examples."
        meta={
          <>
            <Badge tone="accent">
              {data.counts.firms} firms · {data.counts.people} people
            </Badge>
            {selectedList ? (
              <Badge>
                {selectedList.name} · {selectedList.count}
              </Badge>
            ) : null}
            {requestedListId && !selectedList ? <Badge tone="warning">List not found</Badge> : null}
          </>
        }
        actions={
          <>
            {requestedListId ? (
              <Button
                tone="quiet"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('list');
                  setSearchParams(next, { replace: true });
                }}
              >
                Clear list
              </Button>
            ) : null}
            <Button
              icon={<Download aria-hidden="true" />}
              loading={exporting}
              onClick={() => void exportData()}
            >
              Export
            </Button>
            <InvestorCsvImportButton />
            <Button
              tone="primary"
              icon={<Plus aria-hidden="true" />}
              onClick={() => setAddOpen(true)}
            >
              Add investor
            </Button>
          </>
        }
      />

      <div className="view-tabs" role="tablist" aria-label="Investor views">
        {INVESTOR_VIEWS.map((item) => (
          <button
            id={`investor-tab-${item}`}
            role="tab"
            aria-controls="investor-panel"
            aria-selected={view === item}
            tabIndex={view === item ? 0 : -1}
            key={item}
            onClick={() => setView(item)}
            onKeyDown={(event) => {
              const currentIndex = INVESTOR_VIEWS.indexOf(item);
              const nextIndex =
                event.key === 'ArrowRight'
                  ? (currentIndex + 1) % INVESTOR_VIEWS.length
                  : event.key === 'ArrowLeft'
                    ? (currentIndex - 1 + INVESTOR_VIEWS.length) % INVESTOR_VIEWS.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? INVESTOR_VIEWS.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const nextView = INVESTOR_VIEWS[nextIndex]!;
              setView(nextView);
              window.requestAnimationFrame(() =>
                document.getElementById(`investor-tab-${nextView}`)?.focus(),
              );
            }}
          >
            {item === 'portfolio' ? 'Portfolio evidence' : titleCase(item)}
            <span>
              {item === 'firms'
                ? listInvestors.length
                : item === 'people'
                  ? filteredPeople.length
                  : listInvestors.reduce((sum, investor) => sum + investor.portfolioCount, 0)}
            </span>
          </button>
        ))}
      </div>

      <div
        id="investor-panel"
        role="tabpanel"
        aria-labelledby={`investor-tab-${view}`}
        className="investor-view-panel"
      >
        <div className="toolbar investor-toolbar">
          <div className="toolbar__group">
            <SearchField value={query} onChange={setQuery} label={`Search ${view}`} />
            {view !== 'people' ? (
              <label className="fit-filter">
                <Filter aria-hidden="true" />
                <span>Filter by investor type</span>
                <select
                  value={investorKind}
                  onChange={(event) => setInvestorKind(event.target.value as InvestorKind | 'all')}
                >
                  <option value="all">All types</option>
                  {availableKinds.map((value) => (
                    <option key={value} value={value}>
                      {titleCase(value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {view === 'firms' ? (
              <>
                <Button
                  tone={targetOnly ? 'primary' : 'secondary'}
                  icon={<Filter aria-hidden="true" />}
                  onClick={() => setTargetOnly((value) => !value)}
                >
                  Current round
                </Button>
                <label className="fit-filter">
                  <SlidersHorizontal aria-hidden="true" />
                  <span>Minimum fit</span>
                  <select
                    value={minimumFit}
                    onChange={(event) => setMinimumFit(Number(event.target.value))}
                  >
                    <option value={0}>Any</option>
                    <option value={60}>60+</option>
                    <option value={70}>70+</option>
                    <option value={80}>80+</option>
                  </select>
                </label>
              </>
            ) : null}
          </div>
          <span className="result-count">
            {view === 'people'
              ? filteredPeople.length
              : view === 'portfolio'
                ? portfolioInvestors.length
                : filteredInvestors.length}{' '}
            results
          </span>
        </div>

        {view === 'firms' ? (
          filteredInvestors.length ? (
            <InvestorTable investors={filteredInvestors} />
          ) : (
            <EmptyState
              title="No investors match these filters"
              detail={
                requestedListId
                  ? 'Edit the selected list, clear it, or adjust the current filters.'
                  : 'Clear the search or type filter, or lower the minimum fit threshold.'
              }
            />
          )
        ) : view === 'people' ? (
          filteredPeople.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Firm & role</th>
                    <th scope="col">Focus</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Relationship</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPeople.map((person) => (
                    <tr key={person.id}>
                      <td>
                        <span className="data-table__primary">{person.name}</span>
                      </td>
                      <td>
                        <span>{person.firmName ?? 'Independent'}</span>
                        <span className="data-table__secondary">
                          {person.title ?? titleCase(person.investorKinds[0] ?? 'investor')}
                        </span>
                      </td>
                      <td>{person.sectors.slice(0, 3).join(' · ') || 'Broad'}</td>
                      <td>
                        <span>{person.email ?? 'No verified email'}</span>
                        <span className="data-table__secondary">
                          {person.linkedinUrl ? 'LinkedIn available' : 'No LinkedIn URL'}
                        </span>
                      </td>
                      <td>
                        {person.replied ? (
                          <Badge tone="success">Replied</Badge>
                        ) : person.contacted ? (
                          <Badge tone="info">Contacted</Badge>
                        ) : (
                          <Badge>Uncontacted</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No people match this view"
              detail="Clear the search, open another list, or add a person to an investor record."
            />
          )
        ) : (
          <>
            <p className="portfolio-index__note">
              This is a research coverage index, not a complete portfolio inventory. Open a firm to
              review the sourced company names and evidence.
            </p>
            {portfolioInvestors.length ? (
              <div className="portfolio-index">
                {portfolioInvestors.map((investor) => (
                  <button
                    key={investor.id}
                    onClick={() => navigate(`/investors/${investor.id}#portfolio`)}
                  >
                    <strong>{investor.name}</strong>
                    <span>
                      {investor.portfolioCount} sourced{' '}
                      {investor.portfolioCount === 1 ? 'example' : 'examples'}
                    </span>
                    <span>{investor.sectors.slice(0, 4).join(' · ') || 'Focus not verified'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No portfolio examples in this view"
                detail="Portfolio coverage is unknown until a source-backed example is added."
              />
            )}
          </>
        )}
      </div>

      <Dialog
        open={addOpen}
        onClose={() => {
          if (!adding) setAddOpen(false);
        }}
        title="Add an investor"
        description="Create a private local firm record. Add sources before contributing public facts."
        footer={
          <>
            <Button tone="quiet" disabled={adding} onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              loading={adding}
              disabled={!name.trim() || Boolean(websiteError)}
              onClick={() => void addInvestor()}
            >
              Add investor
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <TextField
            label="Firm or investor name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          <label className="field">
            <span className="field__label">Investor type</span>
            <select
              className="select"
              value={kind}
              onChange={(event) => setKind(event.target.value as InvestorKind)}
            >
              {(
                [
                  'venture_capital',
                  'micro_vc',
                  'angel',
                  'angel_network',
                  'scout',
                  'accelerator',
                  'venture_studio',
                  'corporate_vc',
                  'family_office',
                  'syndicate',
                  'crypto_fund',
                  'solo_gp',
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Website (optional)"
            type="url"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            {...(websiteError ? { error: websiteError } : {})}
          />
          <TextField
            label="Headquarters (optional)"
            value={headquarters}
            onChange={(event) => setHeadquarters(event.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
