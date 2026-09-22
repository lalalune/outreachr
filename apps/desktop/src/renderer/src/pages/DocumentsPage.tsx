import {
  ArchiveRestore,
  ExternalLink,
  FileArchive,
  FileCheck,
  FileText,
  FolderOpen,
  Link2,
  Plus,
  Shield,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from '../lib/router';
import type { KnowledgeItem, WorkspaceFileInventory } from '../../../shared/contracts';
import { isSecureExternalUrl } from '../lib/external-links';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  Section,
  TextField,
} from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';

type PackageKind = 'short_deck' | 'full_deck' | 'diligence_index';

interface PackageDefinition {
  kind: PackageKind;
  title: string;
  missingStatus: 'Missing' | 'Later';
  missingGuidance: string;
}

const PACKAGE_DEFINITIONS: PackageDefinition[] = [
  {
    kind: 'short_deck',
    title: 'Short deck',
    missingStatus: 'Missing',
    missingGuidance: 'Add a concise deck only when you want an outreach-ready reference.',
  },
  {
    kind: 'full_deck',
    title: 'Full fundraising deck',
    missingStatus: 'Missing',
    missingGuidance: 'Add the current fundraising deck for meetings or an explicit follow-up.',
  },
  {
    kind: 'diligence_index',
    title: 'Diligence / data-room index',
    missingStatus: 'Later',
    missingGuidance:
      'Link this when diligence begins; it does not need to be shared during outreach.',
  },
];

function isDocumentReference(item: KnowledgeItem): boolean {
  return /^https?:\/\//iu.test(item.content) || item.content.startsWith('file:');
}

function normalizedTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function packageKind(item: KnowledgeItem): PackageKind | null {
  const title = normalizedTitle(item.title);
  if (/\b(?:diligence|data room|dataroom|ddq)\b/u.test(title)) return 'diligence_index';
  if (/\bone page(?:r)?\b/u.test(title)) return 'short_deck';

  const isDeck = /\b(?:deck|slides?)\b/u.test(title);
  if (!isDeck) return null;
  if (/\b(?:short|teaser|intro|introduction|overview|outreach|summary|concise)\b/u.test(title))
    return 'short_deck';
  return 'full_deck';
}

function itemUpdatedAt(item: KnowledgeItem): number {
  const timestamp = Date.parse(item.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function currentPackageItems(items: KnowledgeItem[]): Map<PackageKind, KnowledgeItem> {
  const current = new Map<PackageKind, KnowledgeItem>();
  for (const item of items) {
    const kind = packageKind(item);
    if (!kind) continue;
    const existing = current.get(kind);
    if (!existing || itemUpdatedAt(item) > itemUpdatedAt(existing)) current.set(kind, item);
  }
  return current;
}

function disclosureGuidance(kind: PackageKind, policy: KnowledgeItem['sharePolicy']): string {
  if (policy === 'internal') {
    return 'Internal only; Outreachr will not treat it as shareable.';
  }
  if (policy === 'diligence_only') {
    return 'Diligence only; share it only after an explicit request.';
  }
  if (kind === 'short_deck') {
    return policy === 'safe_for_outreach'
      ? 'Safe for outreach; every share still requires founder approval.'
      : 'Meeting only; it stays out of initial outreach.';
  }
  if (kind === 'full_deck') {
    return policy === 'meeting_only'
      ? 'Meeting only; suitable for a scheduled meeting or explicit follow-up.'
      : 'Safe for outreach; consider using the short deck first and review every share.';
  }
  return policy === 'meeting_only'
    ? 'Meeting only; confirm the diligence request before granting provider access.'
    : 'Safe for outreach is broader than this material usually needs; consider tightening its policy.';
}

export function DocumentsPage(): React.JSX.Element {
  const { data, command, notify } = useWorkspace();
  const navigate = useNavigate();
  const [linkOpen, setLinkOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [sharePolicy, setSharePolicy] = useState<KnowledgeItem['sharePolicy']>('meeting_only');
  const [savingLink, setSavingLink] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const cloud = data?.hosting === 'cloud';
  const [storage, setStorage] = useState<WorkspaceFileInventory | null>(null);
  const [storageError, setStorageError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    if (cloud && window.outreachr.cloudFiles)
      void window.outreachr.cloudFiles
        .list()
        .then((value) => {
          if (current) {
            setStorage(value);
            setStorageError('');
          }
        })
        .catch((error: Error) => {
          if (current) setStorageError(error.message);
        });
    return () => {
      current = false;
    };
  }, [cloud, data]);
  if (!data) return <></>;
  const documentKnowledge = data.knowledge.filter(isDocumentReference);
  const suggestedPackage = currentPackageItems(documentKnowledge);
  const normalizedUrl = url.trim();
  const urlError =
    normalizedUrl && !isSecureExternalUrl(normalizedUrl)
      ? 'Use a complete, credential-free HTTPS URL.'
      : undefined;

  const addLink = async (): Promise<void> => {
    if (!title.trim() || !isSecureExternalUrl(normalizedUrl)) return;
    setSavingLink(true);
    try {
      await command('knowledge.save', {
        title: title.trim(),
        category: 'company',
        content: normalizedUrl,
        sharePolicy,
      });
      setTitle('');
      setUrl('');
      setLinkOpen(false);
      notify({ tone: 'success', title: 'Document link tracked' });
    } finally {
      setSavingLink(false);
    }
  };

  const addFile = async (): Promise<void> => {
    setAddingFile(true);
    try {
      const path = await window.outreachr.selectFile();
      if (!path) return;
      const uploaded = cloud ? await window.outreachr.cloudFiles?.list() : null;
      const filename =
        uploaded?.files.find((file) => `cloud-file:${file.id}` === path)?.name ??
        path.split(/[\\/]/u).at(-1) ??
        'Document';
      await command('knowledge.save', {
        title: filename,
        category: 'company',
        content: `file:${path}`,
        sharePolicy: 'meeting_only',
      });
      notify({
        tone: 'success',
        title: cloud ? 'Document uploaded' : 'Local document tracked',
        detail: cloud
          ? 'Stored in this workspace and readable by its members.'
          : 'The source file stays where you chose it.',
      });
    } finally {
      setAddingFile(false);
    }
  };

  const openItem = async (item: KnowledgeItem): Promise<void> => {
    if (isSecureExternalUrl(item.content)) await window.outreachr.openExternal(item.content);
    else if (item.content.startsWith('file:'))
      await window.outreachr.revealPath(item.content.slice(5));
    else if (/^https?:\/\//iu.test(item.content)) {
      notify({
        tone: 'error',
        title: 'Document link was not opened',
        detail: 'Update this reference to a credential-free HTTPS URL before opening it.',
      });
    } else void navigate('/knowledge');
  };

  return (
    <div className="page">
      <PageHeader
        title="Documents & data room"
        description={
          cloud
            ? 'Upload documents to this workspace or track external links. Workspace members can read uploaded files; disclosure labels guide outreach, not member access.'
            : 'Track founder-controlled links and disclosure state. Outreachr does not silently upload local files.'
        }
        actions={
          <>
            <Button icon={<Link2 aria-hidden="true" />} onClick={() => setLinkOpen(true)}>
              Add link
            </Button>
            <Button
              tone="primary"
              icon={<Plus aria-hidden="true" />}
              loading={addingFile}
              onClick={() => void addFile()}
            >
              {cloud ? 'Upload workspace document' : 'Track local document'}
            </Button>
          </>
        }
      />
      {cloud && (
        <Section
          title="Workspace storage"
          description="Documents are shared with workspace members. Unlinked uploads expire after 24 hours. Removing a file does not revoke a copy already downloaded."
        >
          {storageError && <p role="alert">{storageError}</p>}
          {storage && (
            <>
              <p>
                {(storage.usedBytes / 1024 / 1024).toFixed(1)} MB of{' '}
                {storage.limitBytes / 1024 / 1024} MB used · 25 MB per file
              </p>
              {storage.files.map((file) => (
                <div key={file.id}>
                  <span>
                    {file.name} · {(file.bytes / 1024).toFixed(1)} KB
                    {file.expiresAt ? ' · temporary upload' : ' · workspace document'}
                  </span>{' '}
                  {file.canRemove && (
                    <Button tone="quiet" onClick={() => setRemoving(`cloud-file:${file.id}`)}>
                      Remove file
                    </Button>
                  )}
                </div>
              ))}
            </>
          )}
        </Section>
      )}
      {removing && (
        <Dialog open title="Remove workspace file?" onClose={() => setRemoving(null)}>
          <p>
            This removes the stored file for every workspace member. Document references will also
            be removed. Download a copy first if needed.
          </p>
          <Button onClick={() => setRemoving(null)}>Keep file</Button>
          <Button
            tone="danger"
            onClick={() => {
              const handle = removing;
              void (async () => {
                // Remove references first; if file removal fails, the inventory keeps it recoverable.
                for (const item of data.knowledge.filter(
                  (item) => item.content === `file:${handle}`,
                ))
                  await command('knowledge.remove', { id: item.id });
                await window.outreachr.cloudFiles?.remove(handle);
                setStorage(await window.outreachr.cloudFiles!.list());
                setRemoving(null);
                notify({ tone: 'success', title: 'Workspace file removed' });
              })().catch((error: Error) => setStorageError(error.message));
            }}
          >
            Remove file
          </Button>
        </Dialog>
      )}
      <div className="document-policy">
        <Shield aria-hidden="true" />
        <div>
          <strong>Access is never granted automatically.</strong>
          <p>
            Outreachr can prepare a checklist or approved email, but the founder controls every
            data-room permission in the original provider.
          </p>
        </div>
      </div>
      <Section
        title="Round materials"
        description="The current package for outreach, meetings, and diligence."
      >
        {documentKnowledge.length ? (
          <div className="document-list">
            {documentKnowledge.map((item) => (
              <article key={item.id}>
                <span aria-hidden="true">
                  <FileText />
                </span>
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    Founder-controlled reference · {item.sharePolicy.replaceAll('_', ' ')}
                  </small>
                </div>
                <Badge tone={item.sharePolicy === 'safe_for_outreach' ? 'success' : 'warning'}>
                  {item.sharePolicy.replaceAll('_', ' ')}
                </Badge>
                <Button
                  tone="quiet"
                  icon={<ExternalLink aria-hidden="true" />}
                  onClick={() => void openItem(item)}
                >
                  Open
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No round documents linked"
            detail="Add a deck, data-room index, metrics snapshot, or product demo link and choose when it may be shared."
          />
        )}
      </Section>
      <Section
        title="Suggested package"
        description="Matched from your tracked links and local references. A match does not grant access or prove that a document is current."
      >
        <ul className="document-checklist" aria-label="Suggested package status">
          {PACKAGE_DEFINITIONS.map((definition) => {
            const current = suggestedPackage.get(definition.kind);
            const PackageIcon = definition.kind === 'diligence_index' ? FileArchive : FileCheck;
            return (
              <li key={definition.kind}>
                <PackageIcon aria-hidden="true" />
                <span>
                  <strong>{definition.title}</strong>
                  {current ? <small>Current tracked item: {current.title}</small> : null}
                  <small>
                    {current
                      ? disclosureGuidance(definition.kind, current.sharePolicy)
                      : definition.missingGuidance}
                  </small>
                </span>
                <Badge
                  tone={
                    current
                      ? 'success'
                      : definition.missingStatus === 'Missing'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {current ? 'Linked' : definition.missingStatus}
                </Badge>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section
        title="Local portability"
        description="Encrypted backups contain the complete SQLite vault. Tracked external files remain under founder control and must be backed up separately."
      >
        <div className="portability-actions">
          <Button
            icon={<ArchiveRestore aria-hidden="true" />}
            onClick={() => navigate('/settings/data')}
          >
            Create encrypted backup
          </Button>
          <Button
            icon={<FolderOpen aria-hidden="true" />}
            onClick={() => void window.outreachr.revealPath(data.vaultPath)}
          >
            Show local vault
          </Button>
        </div>
      </Section>
      <Dialog
        open={linkOpen}
        onClose={() => {
          if (!savingLink) setLinkOpen(false);
        }}
        title="Track a document link"
        description="Outreachr stores the reference and disclosure policy, never the provider permission."
        footer={
          <>
            <Button tone="quiet" disabled={savingLink} onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              loading={savingLink}
              disabled={!title.trim() || !isSecureExternalUrl(normalizedUrl)}
              onClick={() => void addLink()}
            >
              Save link
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <TextField
            label="URL"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            {...(urlError ? { error: urlError } : {})}
          />
          <label className="field">
            <span className="field__label">Disclosure policy</span>
            <select
              className="select"
              value={sharePolicy}
              onChange={(event) =>
                setSharePolicy(event.target.value as KnowledgeItem['sharePolicy'])
              }
            >
              <option value="internal">Internal only</option>
              <option value="safe_for_outreach">Safe for outreach</option>
              <option value="meeting_only">Meeting only</option>
              <option value="diligence_only">Diligence only</option>
            </select>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
