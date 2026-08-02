import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { FounderSetupInput, RoundState } from '../../../shared/contracts';
import { Badge, Button, TextField } from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

const steps = ['Founder', 'Company', 'Round', 'Privacy', 'Ready'] as const;

export function OnboardingFlow(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FounderSetupInput>({
    founderName: '',
    founderEmail: '',
    companyName: '',
    companyOneLiner: '',
    stage: 'seed',
    targetAmount: 3000000,
    targetCheckMinimum: 250000,
    targetCheckMaximum: 1000000,
    sectors: ['AI', 'Agentic'],
    geographies: ['United States'],
    narrative: '',
    postalAddress: '',
  });

  const valid = useMemo(() => {
    if (step === 0)
      return form.founderName.trim().length > 1 && /.+@.+\..+/.test(form.founderEmail);
    if (step === 1)
      return form.companyName.trim().length > 1 && form.companyOneLiner.trim().length > 8;
    if (step === 2)
      return (
        form.targetAmount > 0 &&
        (form.targetCheckMinimum ?? 0) <= (form.targetCheckMaximum ?? Number.MAX_SAFE_INTEGER)
      );
    return true;
  }, [form, step]);

  const update = <K extends keyof FounderSetupInput>(key: K, value: FounderSetupInput[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const finish = async (): Promise<void> => {
    setSaving(true);
    try {
      await command('onboarding.complete', form);
      notify({
        tone: 'success',
        title: 'Your local round is ready',
        detail: 'Pinned research seed validated and imported.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onboarding-shell">
      <aside className="onboarding-aside">
        <div className="onboarding-brand">
          <span className="brand-mark">O</span>
          <strong>Outreachr</strong>
        </div>
        <div className="onboarding-aside__copy">
          <Badge tone="accent">Local-first fundraising</Badge>
          <h1>Begin with a trustworthy round brief.</h1>
          <p>
            Outreachr imports the public investor seed, keeps private activity in one local SQLite
            vault, and asks before any external action.
          </p>
        </div>
        <ol>
          {steps.map((label, index) => (
            <li
              className={
                index === step
                  ? 'onboarding-step onboarding-step--active'
                  : index < step
                    ? 'onboarding-step onboarding-step--done'
                    : 'onboarding-step'
              }
              key={label}
            >
              <span>{index < step ? <Check aria-hidden="true" /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <div className="onboarding-local">
          <Database aria-hidden="true" />
          <span>
            <strong>{data?.seedVersion ?? 'Seed'} ready</strong>
            <small>
              {data?.counts.firms ?? 192} firms · {data?.counts.people ?? 192} people
            </small>
          </span>
        </div>
      </aside>
      <main className="onboarding-main">
        <div className="onboarding-panel">
          {step === 0 ? (
            <>
              <header>
                <span>Founder profile</span>
                <h2>Who is running this round?</h2>
                <p>This is the only workspace role. Outreachr does not create an online account.</p>
              </header>
              <div className="form-grid">
                <TextField
                  label="Your name"
                  value={form.founderName}
                  onChange={(event) => update('founderName', event.target.value)}
                  autoFocus
                />
                <TextField
                  label="Work email"
                  type="email"
                  value={form.founderEmail}
                  onChange={(event) => update('founderEmail', event.target.value)}
                  hint="Used as the default sender identity after you connect a provider."
                />
              </div>
            </>
          ) : null}
          {step === 1 ? (
            <>
              <header>
                <span>Company brief</span>
                <h2>What are you building?</h2>
                <p>
                  A concise brief powers matching, meeting preparation, and truthful
                  personalization.
                </p>
              </header>
              <div className="form-grid">
                <TextField
                  label="Company name"
                  value={form.companyName}
                  onChange={(event) => update('companyName', event.target.value)}
                  autoFocus
                />
                <TextField
                  label="One-line description"
                  value={form.companyOneLiner}
                  onChange={(event) => update('companyOneLiner', event.target.value)}
                  placeholder="What you build, for whom, and why it matters"
                />
                <label className="field">
                  <span className="field__label">Fundraising narrative</span>
                  <textarea
                    className="textarea"
                    value={form.narrative}
                    onChange={(event) => update('narrative', event.target.value)}
                    placeholder="Current traction, insight, team advantage, and why now. Estimates should be labeled."
                  />
                </label>
              </div>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <header>
                <span>Round strategy</span>
                <h2>Define money fit before ranking.</h2>
                <p>
                  Check range and stage are hard eligibility signals. Geography is a preference
                  unless a mandate says otherwise.
                </p>
              </header>
              <div className="form-grid form-grid--two">
                <label className="field">
                  <span className="field__label">Round stage</span>
                  <select
                    className="select"
                    value={form.stage}
                    onChange={(event) => update('stage', event.target.value as RoundState['stage'])}
                  >
                    <option value="pre_seed">Pre-seed</option>
                    <option value="seed">Seed</option>
                    <option value="series_a">Series A</option>
                  </select>
                </label>
                <TextField
                  label="Target raise (USD)"
                  type="number"
                  value={form.targetAmount}
                  onChange={(event) => update('targetAmount', Number(event.target.value))}
                />
                <TextField
                  label="Minimum useful check"
                  type="number"
                  value={form.targetCheckMinimum ?? ''}
                  onChange={(event) =>
                    update(
                      'targetCheckMinimum',
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                />
                <TextField
                  label="Maximum expected check"
                  type="number"
                  value={form.targetCheckMaximum ?? ''}
                  onChange={(event) =>
                    update(
                      'targetCheckMaximum',
                      event.target.value ? Number(event.target.value) : null,
                    )
                  }
                />
                <TextField
                  label="Sector tags"
                  value={form.sectors.join(', ')}
                  onChange={(event) =>
                    update(
                      'sectors',
                      event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                  hint="Multiple tags are encouraged."
                />
                <TextField
                  label="Geographies"
                  value={form.geographies.join(', ')}
                  onChange={(event) =>
                    update(
                      'geographies',
                      event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </div>
            </>
          ) : null}
          {step === 3 ? (
            <>
              <header>
                <span>Local privacy</span>
                <h2>Your fundraising history stays on this device.</h2>
                <p>
                  Provider and agent connections are optional. A real sender postal address is
                  required before Outreachr can approve or send email.
                </p>
              </header>
              <div className="privacy-promises">
                <div>
                  <Database aria-hidden="true" />
                  <span>
                    <strong>One SQLite vault</strong>
                    <small>
                      Canonical records, history, evidence, notes, drafts, and audit entries.
                    </small>
                  </span>
                </div>
                <div>
                  <LockKeyhole aria-hidden="true" />
                  <span>
                    <strong>OS-backed secrets</strong>
                    <small>
                      Tokens are encrypted outside renderer access; insecure Linux fallback is
                      rejected.
                    </small>
                  </span>
                </div>
                <div>
                  <ShieldCheck aria-hidden="true" />
                  <span>
                    <strong>Approval-bound sends</strong>
                    <small>
                      Exact-content approval, visible sender footer, and database-level duplicate
                      prevention.
                    </small>
                  </span>
                </div>
                <div>
                  <Sparkles aria-hidden="true" />
                  <span>
                    <strong>Per-run agent context</strong>
                    <small>Private content is disclosed only when explicitly selected.</small>
                  </span>
                </div>
              </div>
              <label className="field">
                <span className="field__label">
                  Sender postal address <small>(optional during setup)</small>
                </span>
                <textarea
                  className="textarea"
                  value={form.postalAddress ?? ''}
                  onChange={(event) => update('postalAddress', event.target.value)}
                  placeholder={'Street address\nCity, state ZIP\nUnited States'}
                />
                <span className="field__hint">
                  Stored only in this vault and appended to new drafts. You can finish setup without
                  it, but approval and sending stay blocked until it is configured.
                </span>
              </label>
            </>
          ) : null}
          {step === 4 ? (
            <>
              <header>
                <span>Ready</span>
                <h2>Your local workspace is ready to build.</h2>
                <p>
                  Outreachr will create the vault, validate and import the research-grade seed, and
                  open a cited work queue. Public facts still require founder review before use.
                </p>
              </header>
              <div className="ready-summary">
                <div>
                  <strong>{form.companyName}</strong>
                  <span>{form.companyOneLiner}</span>
                </div>
                <dl>
                  <div>
                    <dt>Stage</dt>
                    <dd>{form.stage.replace('_', '-')}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {form.targetAmount.toLocaleString('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        maximumFractionDigits: 0,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>Check fit</dt>
                    <dd>
                      {form.targetCheckMinimum?.toLocaleString()}–
                      {form.targetCheckMaximum?.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Sender footer</dt>
                    <dd>{form.postalAddress?.trim() ? 'Configured' : 'Required before send'}</dd>
                  </div>
                  <div>
                    <dt>Seed</dt>
                    <dd>{data?.counts.firms ?? 192} firms</dd>
                  </div>
                </dl>
                <div className="ready-next">
                  <Mail aria-hidden="true" />
                  <p>
                    To sync or send, open Settings → Mail & calendar. Create a founder-owned desktop
                    OAuth client, follow the exact callback and scope instructions, and paste only
                    its public client ID—never a client secret or account password.
                  </p>
                </div>
                <div className="ready-next">
                  <Sparkles aria-hidden="true" />
                  <p>
                    Agents are optional. Settings → Agents supports Codex through official ChatGPT
                    sign-in. Claude can use a founder-provided Anthropic API key or, when Anthropic
                    has approved this deployment, an existing local Claude subscription sign-in that
                    the founder explicitly enables. Outreachr never receives the subscription token,
                    and setup-token credentials remain unsupported.
                  </p>
                </div>
              </div>
            </>
          ) : null}
          <footer className="onboarding-footer">
            <Button
              tone="quiet"
              icon={<ArrowLeft aria-hidden="true" />}
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
            >
              Back
            </Button>
            <span>
              {step + 1} of {steps.length}
            </span>
            {step < steps.length - 1 ? (
              <Button
                tone="primary"
                icon={<ArrowRight aria-hidden="true" />}
                disabled={!valid}
                onClick={() => setStep((value) => value + 1)}
              >
                Continue
              </Button>
            ) : (
              <Button
                tone="primary"
                icon={<Check aria-hidden="true" />}
                loading={saving}
                onClick={() => void finish()}
              >
                Create local workspace
              </Button>
            )}
          </footer>
        </div>
      </main>
    </div>
  );
}
