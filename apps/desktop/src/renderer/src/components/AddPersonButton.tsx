import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, Dialog, TextField } from './ui';
import { useWorkspace } from '../state/WorkspaceContext';

export function AddPersonButton({
  firmId,
  firmName,
  onSaved,
}: {
  firmId: string;
  firmName: string;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const { command, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const invalidEmail = [workEmail, personalEmail].some(
    (value) => value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()),
  );
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await command('person.create', {
        firmId,
        name: name.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(workEmail.trim() ? { workEmail: workEmail.trim() } : {}),
        ...(personalEmail.trim() ? { personalEmail: personalEmail.trim() } : {}),
      });
      await onSaved();
      setOpen(false);
      setName('');
      setTitle('');
      setWorkEmail('');
      setPersonalEmail('');
      notify({
        tone: 'success',
        title: 'Person added',
        detail: 'Contact details are private to this workspace.',
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button icon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)}>
        Add person
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!saving) setOpen(false);
        }}
        title={`Add person to ${firmName}`}
        description="Add a contact for this investor. Their details stay private and are excluded from public contributions."
        footer={
          <>
            <Button tone="quiet" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              tone="primary"
              loading={saving}
              disabled={!name.trim() || invalidEmail}
              onClick={() => void save()}
            >
              Save person
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <TextField
            label="Full name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={500}
            autoComplete="off"
          />
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={500}
          />
          <TextField
            label="Work email"
            type="email"
            value={workEmail}
            onChange={(event) => setWorkEmail(event.target.value)}
            maxLength={320}
            hint="Optional. You can add or edit contact details later."
          />
          <TextField
            label="Individual email"
            type="email"
            value={personalEmail}
            onChange={(event) => setPersonalEmail(event.target.value)}
            maxLength={320}
            hint="Optional. Kept private; work email is preferred for outreach."
          />
        </div>
      </Dialog>
    </>
  );
}
