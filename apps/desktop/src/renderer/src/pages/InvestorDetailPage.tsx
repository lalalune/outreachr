import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  Check,
  CircleDollarSign,
  Globe2,
  Link,
  Mail,
  RefreshCw,
  ShieldAlert,
  Star,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from '../lib/router';
import type { InvestorDetail, PersonSummary } from '../../../shared/contracts';
import { isSecureExternalUrl } from '../lib/external-links';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  formatDate,
  formatMoney,
  PageHeader,
  Section,
  Skeleton,
  TextField,
  titleCase,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';
import { AddPersonButton } from '../components/AddPersonButton';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const detailSectionIds = new Set(['people', 'thesis', 'portfolio', 'sources', 'activity']);

function isProfileUrl(value: string, hostnames: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return (
      isSecureExternalUrl(value) &&
      hostnames.some(
        (hostname) => url.hostname === hostname || url.hostname.endsWith(`.${hostname}`),
      )
    );
  } catch {
    return false;
  }
}

function PersonRow({
  person,
  investorName,
}: {
  person: PersonSummary;
  investorName: string;
}): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const [current, setCurrent] = useState(person);
  const [contactOpen, setContactOpen] = useState(false);
  const [workEmail, setWorkEmail] = useState(person.workEmail ?? '');
  const [personalEmail, setPersonalEmail] = useState(person.personalEmail ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(person.linkedinUrl ?? '');
  const [xUrl, setXUrl] = useState(person.xUrl ?? '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => setCurrent(person), [person]);

  const createDraft = async (): Promise<void> => {
    if (!current.email) {
      notify({
        tone: 'error',
        title: 'No recipient email',
        detail: 'Add a work or individual email before drafting outreach.',
      });
      return;
    }
    setDrafting(true);
    try {
      await command('draft.create', {
        personId: current.id,
        provider:
          data?.connectors.find((connector) => connector.state === 'connected')?.provider ??
          'google',
        kind: 'initial',
        subject: `A possible fit for ${investorName}`,
        bodyText: `Hi ${current.name.split(' ')[0]},\n\n`,
      });
      notify({
        tone: 'success',
        title: 'Draft created',
        detail: `Review the exact message to ${current.name} in Outreach.`,
      });
    } finally {
      setDrafting(false);
    }
  };

  const openContact = (): void => {
    setWorkEmail(current.workEmail ?? '');
    setPersonalEmail(current.personalEmail ?? '');
    setLinkedinUrl(current.linkedinUrl ?? '');
    setXUrl(current.xUrl ?? '');
    setSourceUrl('');
    setIsPublic(false);
    setContactOpen(true);
  };

  const normalizedEmail = workEmail.trim().toLowerCase();
  const normalizedPersonalEmail = personalEmail.trim().toLowerCase();
  const normalizedLinkedinUrl = linkedinUrl.trim();
  const normalizedXUrl = xUrl.trim();
  const emailChanged =
    Boolean(normalizedEmail) && normalizedEmail !== current.workEmail?.toLowerCase();
  const personalEmailChanged =
    Boolean(normalizedPersonalEmail) &&
    normalizedPersonalEmail !== current.personalEmail?.toLowerCase();
  const linkedinChanged =
    Boolean(normalizedLinkedinUrl) && normalizedLinkedinUrl !== current.linkedinUrl;
  const xChanged = Boolean(normalizedXUrl) && normalizedXUrl !== current.xUrl;
  const workEmailError =
    normalizedEmail && !emailPattern.test(normalizedEmail)
      ? 'Enter a valid professional email address.'
      : null;
  const personalEmailError =
    normalizedPersonalEmail && !emailPattern.test(normalizedPersonalEmail)
      ? 'Enter a valid individual email address.'
      : null;
  const linkedinError =
    normalizedLinkedinUrl && !isProfileUrl(normalizedLinkedinUrl, ['linkedin.com'])
      ? 'Use a secure linkedin.com profile URL.'
      : null;
  const xError =
    normalizedXUrl && !isProfileUrl(normalizedXUrl, ['x.com', 'twitter.com'])
      ? 'Use a secure x.com or twitter.com profile URL.'
      : null;
  const sourceUrlError =
    isPublic && emailChanged && sourceUrl.trim() && !isSecureExternalUrl(sourceUrl.trim())
      ? 'Use a complete, credential-free HTTPS source URL.'
      : null;
  const contactFormValid =
    !workEmailError &&
    !personalEmailError &&
    !linkedinError &&
    !xError &&
    !sourceUrlError &&
    (!isPublic || !emailChanged || Boolean(sourceUrl.trim()));

  const saveContact = async (): Promise<void> => {
    if (
      !contactFormValid ||
      (!emailChanged && !personalEmailChanged && !linkedinChanged && !xChanged)
    )
      return;
    setSavingContact(true);
    try {
      let updated = current;
      if (emailChanged) {
        updated = await command('person.contact.add', {
          personId: current.id,
          kind: 'work_email',
          value: normalizedEmail,
          visibility: isPublic ? 'public' : 'private',
          ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
          contributionEligible: isPublic && Boolean(sourceUrl.trim()),
        });
      }
      if (personalEmailChanged) {
        updated = await command('person.contact.add', {
          personId: current.id,
          kind: 'personal_email',
          value: normalizedPersonalEmail,
          visibility: 'private',
          contributionEligible: false,
        });
      }
      if (linkedinChanged) {
        updated = await command('person.contact.add', {
          personId: current.id,
          kind: 'linkedin',
          value: normalizedLinkedinUrl,
          visibility: 'public',
          sourceUrl: normalizedLinkedinUrl,
          contributionEligible: false,
        });
      }
      if (xChanged) {
        updated = await command('person.contact.add', {
          personId: current.id,
          kind: 'x',
          value: normalizedXUrl,
          visibility: 'public',
          sourceUrl: normalizedXUrl,
          contributionEligible: false,
        });
      }
      setCurrent(updated);
      setContactOpen(false);
      notify({
        tone: 'success',
        title: 'Contact details saved',
        detail:
          isPublic && emailChanged
            ? 'Public details retain their attributable source; private email stays local by default.'
            : 'Individual email stays private. Professional profiles retain their public URLs as sources and are not automatically exported.',
      });
    } catch {
      // WorkspaceContext already presents the safely redacted command error.
    } finally {
      setSavingContact(false);
    }
  };

  return (
    <>
      <div className="person-row">
        <span className="person-avatar" aria-hidden="true">
          {current.name
            .split(' ')
            .map((part) => part[0])
            .slice(0, 2)
            .join('')}
        </span>
        <div>
          <strong>{current.name}</strong>
          <small>{current.title ?? 'Role not verified'}</small>
        </div>
        <div className="person-row__focus">
          {current.sectors.slice(0, 3).join(' · ') || 'Focus not yet sourced'}
        </div>
        <div className="person-row__links">
          {current.linkedinUrl ? (
            <Button
              tone="quiet"
              size="small"
              icon={<Link aria-hidden="true" />}
              disabled={!isProfileUrl(current.linkedinUrl, ['linkedin.com'])}
              title={
                isProfileUrl(current.linkedinUrl, ['linkedin.com'])
                  ? undefined
                  : 'This saved profile is not a secure LinkedIn URL.'
              }
              onClick={() => void window.outreachr.openExternal(current.linkedinUrl!)}
            >
              LinkedIn
            </Button>
          ) : null}
          {current.xUrl ? (
            <Button
              tone="quiet"
              size="small"
              icon={<ArrowUpRight aria-hidden="true" />}
              disabled={!isProfileUrl(current.xUrl, ['x.com', 'twitter.com'])}
              title={
                isProfileUrl(current.xUrl, ['x.com', 'twitter.com'])
                  ? undefined
                  : 'This saved profile is not a secure X or Twitter URL.'
              }
              onClick={() => void window.outreachr.openExternal(current.xUrl!)}
            >
              X
            </Button>
          ) : null}
          <Button size="small" onClick={openContact}>
            Edit contacts
          </Button>
          <Button
            tone="secondary"
            size="small"
            icon={<Mail aria-hidden="true" />}
            loading={drafting}
            disabled={!current.email || !current.canSendInitial}
            title={
              !current.email
                ? 'Add a work or individual email before drafting.'
                : !current.canSendInitial
                  ? 'Initial outreach is blocked by the canonical-person send ledger or a suppression.'
                  : undefined
            }
            onClick={() => void createDraft()}
          >
            {current.canSendInitial ? 'Draft' : 'Blocked'}
          </Button>
        </div>
      </div>
      <Dialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        title={`Edit contact details for ${current.name}`}
        description="Professional profiles retain their own URL as attribution but are not automatically exported. Work email remains private unless you explicitly mark it public; individual email is always private."
        footer={
          <>
            <Button tone="quiet" onClick={() => setContactOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              loading={savingContact}
              disabled={
                !contactFormValid ||
                (!emailChanged && !personalEmailChanged && !linkedinChanged && !xChanged)
              }
              onClick={() => void saveContact()}
            >
              Save contact details
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <TextField
            label="Work email"
            aria-label="Work email"
            type="email"
            value={workEmail}
            onChange={(event) => setWorkEmail(event.target.value)}
            placeholder="name@firm.com"
            hint="Email changes stay private unless you opt into public contribution below."
            {...(workEmailError ? { error: workEmailError } : {})}
          />
          <TextField
            label="Individual email"
            aria-label="Individual email"
            type="email"
            value={personalEmail}
            onChange={(event) => setPersonalEmail(event.target.value)}
            placeholder="name@example.com"
            hint="Always private, stored only in your local vault, and never included in seed contributions."
            {...(personalEmailError ? { error: personalEmailError } : {})}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
            />
            <span>
              <strong>New work email is publicly listed</strong>
              <small>
                Requires a source URL and may be included in a reviewed public-data contribution.
              </small>
            </span>
          </label>
          {isPublic && emailChanged ? (
            <TextField
              label="Public source URL"
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://firm.example/team"
              {...(sourceUrlError ? { error: sourceUrlError } : {})}
            />
          ) : null}
          <TextField
            label="LinkedIn profile"
            aria-label="LinkedIn profile"
            type="url"
            value={linkedinUrl}
            onChange={(event) => setLinkedinUrl(event.target.value)}
            placeholder="https://www.linkedin.com/in/name"
            hint="Must be a public HTTPS LinkedIn profile."
            {...(linkedinError ? { error: linkedinError } : {})}
          />
          <TextField
            label="X profile"
            aria-label="X profile"
            type="url"
            value={xUrl}
            onChange={(event) => setXUrl(event.target.value)}
            placeholder="https://x.com/handle"
            hint="twitter.com profile URLs are also accepted."
            {...(xError ? { error: xError } : {})}
          />
        </div>
      </Dialog>
    </>
  );
}

export function InvestorDetailPage(): React.JSX.Element {
  const { investorId } = useParams();
  const { getInvestor, command, notify } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [investor, setInvestor] = useState<InvestorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amountOpen, setAmountOpen] = useState(false);
  const [expectedCheck, setExpectedCheck] = useState<number | ''>('');
  const [savingAmount, setSavingAmount] = useState(false);
  const [updatingTarget, setUpdatingTarget] = useState(false);

  useEffect(() => {
    if (!investorId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getInvestor(investorId)
      .then((detail) => {
        if (!cancelled) {
          setInvestor(detail);
          setError(null);
          setExpectedCheck(detail.expectedCheckUsd ?? '');
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Investor could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getInvestor, investorId]);

  useEffect(() => {
    const sectionId = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!investor || !detailSectionIds.has(sectionId)) return;
    document.getElementById(sectionId)?.scrollIntoView?.({ block: 'start' });
  }, [investor, location.hash]);

  const confidenceTone = useMemo(() => {
    if (!investor) return 'neutral' as const;
    if (investor.confidence === 'verified') return 'success' as const;
    if (investor.confidence === 'stale') return 'warning' as const;
    return 'info' as const;
  }, [investor]);

  if (loading) {
    return (
      <div className="page investor-detail-loading" aria-busy="true">
        <span className="sr-only" role="status">
          Loading investor details…
        </span>
        <Skeleton className="skeleton--title" />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }

  if (error || !investor) {
    return (
      <div className="page">
        <PageHeader title="Investor unavailable" />
        <EmptyState
          title="This investor could not be opened"
          detail={error ?? 'This record may have been merged or removed.'}
          action={<Button onClick={() => navigate('/investors')}>Back to investors</Button>}
        />
      </div>
    );
  }

  const toggleTarget = async (): Promise<void> => {
    setUpdatingTarget(true);
    try {
      await command('investor.target', { id: investor.id, target: !investor.target });
      setInvestor((current) => (current ? { ...current, target: !current.target } : current));
      notify({
        tone: 'success',
        title: investor.target ? 'Removed from round' : 'Added to round',
        detail: investor.name,
      });
    } finally {
      setUpdatingTarget(false);
    }
  };

  const saveExpectedCheck = async (): Promise<void> => {
    setSavingAmount(true);
    try {
      const updated = await command('pipeline.amount', {
        investorId: investor.id,
        expectedCheckUsd: expectedCheck === '' ? null : expectedCheck,
      });
      setInvestor((current) =>
        current ? { ...current, expectedCheckUsd: updated.expectedCheckUsd } : current,
      );
      setAmountOpen(false);
      notify({
        tone: 'success',
        title: 'Expected check updated',
        detail:
          expectedCheck === ''
            ? 'No amount is currently counted in round progress.'
            : formatMoney(expectedCheck, true),
      });
    } finally {
      setSavingAmount(false);
    }
  };

  return (
    <div className="page investor-detail-page">
      <button className="back-link" onClick={() => navigate('/investors')}>
        <ArrowLeft aria-hidden="true" /> Investor universe
      </button>
      <PageHeader
        title={investor.name}
        description={investor.description ?? 'No sourced firm description is available yet.'}
        meta={
          <>
            <Badge tone="accent">{titleCase(investor.kind)}</Badge>
            {investor.additionalKinds.map((kind) => (
              <Badge key={kind}>{titleCase(kind)}</Badge>
            ))}
            <Badge tone={confidenceTone}>{investor.confidence}</Badge>
          </>
        }
        actions={
          <>
            {investor.website ? (
              <Button
                icon={<Globe2 aria-hidden="true" />}
                disabled={!isSecureExternalUrl(investor.website)}
                title={
                  isSecureExternalUrl(investor.website)
                    ? undefined
                    : 'Only credential-free HTTPS websites can be opened from Outreachr.'
                }
                onClick={() => void window.outreachr.openExternal(investor.website!)}
              >
                Website
              </Button>
            ) : null}
            <Button
              tone={investor.target ? 'secondary' : 'primary'}
              icon={investor.target ? <Check aria-hidden="true" /> : <Star aria-hidden="true" />}
              loading={updatingTarget}
              onClick={() => void toggleTarget()}
            >
              {investor.target ? 'In this round' : 'Add to round'}
            </Button>
            {investor.target ? (
              <Button
                icon={<CircleDollarSign aria-hidden="true" />}
                onClick={() => setAmountOpen(true)}
              >
                {investor.expectedCheckUsd === null
                  ? 'Record expected check'
                  : formatMoney(investor.expectedCheckUsd, true)}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="investor-brief">
        <div className="fit-score-block">
          <span>Round fit</span>
          <strong>{investor.fitScore}</strong>
          <small>Explainable score, not reply probability</small>
        </div>
        <dl>
          <div>
            <dt>
              <CircleDollarSign aria-hidden="true" /> Initial check
            </dt>
            <dd>
              {formatMoney(investor.check.minimum, true)}–
              {formatMoney(investor.check.maximum, true)}
            </dd>
          </div>
          <div>
            <dt>
              <Building2 aria-hidden="true" /> Current fund
            </dt>
            <dd>{investor.currentFund ?? 'Not verified'}</dd>
          </div>
          <div>
            <dt>
              <Globe2 aria-hidden="true" /> Geography
            </dt>
            <dd>{investor.geographies.join(', ') || investor.headquarters || 'Unknown'}</dd>
          </div>
          <div>
            <dt>Lead behavior</dt>
            <dd>{investor.leadBehavior ?? 'Not verified'}</dd>
          </div>
        </dl>
        <div className="fit-reasons-panel">
          <strong>Why Outreachr ranked this firm</strong>
          <ul>
            {investor.fitReasons.map((reason) => (
              <li key={reason}>
                <Check aria-hidden="true" />
                {reason}
              </li>
            ))}
          </ul>
          {investor.conflict !== 'none' ? (
            <p className="conflict-note">
              <ShieldAlert aria-hidden="true" /> {titleCase(investor.conflict)} portfolio-conflict
              signal. Review evidence before contact.
            </p>
          ) : null}
        </div>
      </div>

      <nav className="detail-tabs" aria-label="Investor detail sections">
        <a href={`#${location.pathname}${location.search}#people`}>
          People <span>{investor.people.length}</span>
        </a>
        <a href={`#${location.pathname}${location.search}#thesis`}>Thesis</a>
        <a href={`#${location.pathname}${location.search}#portfolio`}>
          Portfolio <span>{investor.portfolio.length}</span>
        </a>
        <a href={`#${location.pathname}${location.search}#sources`}>
          Sources <span>{investor.sources.length}</span>
        </a>
        <a href={`#${location.pathname}${location.search}#activity`}>
          Activity <span>{investor.activity.length}</span>
        </a>
      </nav>

      <Section
        title="Relevant people"
        description="Contact and relationship state belongs to the canonical person, not only the firm."
        action={
          <AddPersonButton
            firmId={investor.id}
            firmName={investor.name}
            onSaved={async () => setInvestor(await getInvestor(investor.id))}
          />
        }
        className="detail-section"
      >
        <div id="people" className="people-list">
          {investor.people.length ? (
            investor.people.map((person) => (
              <PersonRow key={person.id} person={person} investorName={investor.name} />
            ))
          ) : (
            <EmptyState
              title="No partner records yet"
              detail="Add a person and their email to plan outreach."
            />
          )}
        </div>
      </Section>

      <Section
        title="Investment thesis"
        description="Current selected fact; inspect the sources below for history and caveats."
        className="detail-section"
      >
        <div id="thesis" className="thesis-copy">
          <p>
            {investor.thesis ??
              'No current thesis statement has been selected from source evidence.'}
          </p>
          <div className="tag-cloud">
            {[...investor.sectors, ...investor.stages].map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Portfolio evidence"
        description="Illustrative, sourced examples—not a complete investment history."
        className="detail-section"
      >
        <div id="portfolio" className="portfolio-list">
          {investor.portfolio.length ? (
            investor.portfolio.map((item) => (
              <div key={item.id}>
                <strong>{item.companyName}</strong>
                <span>{[item.round, item.sector].filter(Boolean).join(' · ') || 'Investment'}</span>
                <span>{formatDate(item.announcedAt)}</span>
                <Button
                  tone="quiet"
                  size="small"
                  icon={<ArrowUpRight aria-hidden="true" />}
                  disabled={!isSecureExternalUrl(item.source.url)}
                  title={
                    isSecureExternalUrl(item.source.url)
                      ? undefined
                      : 'Only credential-free HTTPS sources can be opened from Outreachr.'
                  }
                  onClick={() => void window.outreachr.openExternal(item.source.url)}
                >
                  Source
                </Button>
              </div>
            ))
          ) : (
            <EmptyState
              title="No portfolio examples"
              detail="This is unknown, not evidence that the investor has no portfolio."
            />
          )}
        </div>
      </Section>

      <Section
        title="Evidence ledger"
        description="Every material claim retains its URL, observation date, confidence, and redistribution class."
        className="detail-section"
        action={
          <Button
            tone="quiet"
            icon={<RefreshCw aria-hidden="true" />}
            onClick={() => navigate('/agent')}
          >
            Research updates
          </Button>
        }
      >
        <div id="sources" className="source-list">
          {investor.sources.length ? (
            investor.sources.map((source) => (
              <article key={source.id}>
                <div>
                  <strong>{source.title}</strong>
                  <p>
                    {source.publisher} · observed {formatDate(source.observedAt)}
                  </p>
                </div>
                <Badge
                  tone={
                    source.confidence === 'verified'
                      ? 'success'
                      : source.confidence === 'stale'
                        ? 'warning'
                        : 'info'
                  }
                >
                  {source.confidence}
                </Badge>
                <Badge>{titleCase(source.rights)}</Badge>
                <Button
                  tone="quiet"
                  size="small"
                  icon={<ArrowUpRight aria-hidden="true" />}
                  disabled={!isSecureExternalUrl(source.url)}
                  title={
                    isSecureExternalUrl(source.url)
                      ? undefined
                      : 'Only credential-free HTTPS sources can be opened from Outreachr.'
                  }
                  onClick={() => void window.outreachr.openExternal(source.url)}
                >
                  {isSecureExternalUrl(source.url) ? 'Open' : 'Unavailable'}
                </Button>
              </article>
            ))
          ) : (
            <EmptyState
              title="No source records"
              detail="Treat unsourced claims as unknown until attributable evidence is added."
            />
          )}
        </div>
      </Section>

      <Section
        title="Activity"
        description="Private round history remains local and is excluded from public seed contributions."
        className="detail-section"
      >
        <div id="activity" className="timeline">
          {investor.activity.length ? (
            investor.activity.map((activity) => (
              <div key={activity.id}>
                <span className="timeline__dot" aria-hidden="true" />
                <div>
                  <strong>{activity.title}</strong>
                  {activity.detail ? <p>{activity.detail}</p> : null}
                </div>
                <time dateTime={activity.occurredAt}>{formatDate(activity.occurredAt, true)}</time>
              </div>
            ))
          ) : (
            <EmptyState
              title="No private activity"
              detail="Emails, meetings, notes, and stage changes will appear here."
            />
          )}
        </div>
      </Section>
      <Dialog
        open={amountOpen}
        onClose={() => setAmountOpen(false)}
        title={`Expected check from ${investor.name}`}
        description="This founder estimate drives soft-circle and committed capital totals. It is private and never included in public data contributions."
        footer={
          <>
            <Button tone="quiet" onClick={() => setAmountOpen(false)}>
              Cancel
            </Button>
            <Button tone="primary" loading={savingAmount} onClick={() => void saveExpectedCheck()}>
              Save amount
            </Button>
          </>
        }
      >
        <TextField
          label="Expected check (USD)"
          type="number"
          min="0"
          step="1000"
          value={expectedCheck}
          onChange={(event) => {
            if (event.target.value === '') {
              setExpectedCheck('');
              return;
            }
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value)) setExpectedCheck(Math.max(0, value));
          }}
          hint="Leave blank when no credible amount has been discussed."
        />
      </Dialog>
    </div>
  );
}
