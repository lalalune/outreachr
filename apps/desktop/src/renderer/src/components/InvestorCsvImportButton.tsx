import { useState } from 'react';
import { Upload } from 'lucide-react';
import type { InvestorCsvPreview } from '../../../shared/contracts';
import { Button, Dialog } from './ui';
import { useWorkspace } from '../state/WorkspaceContext';

export function InvestorCsvImportButton(): React.JSX.Element {
  const { command, notify } = useWorkspace();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<InvestorCsvPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async (): Promise<void> => {
    setBusy(true);
    try {
      const selected = await window.outreachr.selectFile([
        { name: 'CSV files', extensions: ['csv'] },
      ]);
      if (!selected) return;
      setPreview(null);
      const result = await command('data.previewInvestorCsv', { path: selected });
      setPath(selected);
      setPreview(result);
    } finally {
      setBusy(false);
    }
  };
  const importRows = async (): Promise<void> => {
    if (!preview || preview.errors.length) return;
    setBusy(true);
    try {
      const result = await command('data.importInvestorCsv', { path, sha256: preview.sha256 });
      setPreview(null);
      notify({
        tone: 'success',
        title: 'CSV imported',
        detail: `Investors added: ${result.importedInvestors}. People added: ${result.importedPeople}. Existing rows kept: ${result.skippedRows}.`,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button icon={<Upload aria-hidden="true" />} loading={busy} onClick={() => void choose()}>
        Import CSV
      </Button>
      <Dialog
        open={preview !== null}
        title="Review investor CSV"
        description="New investors and contacts stay private. Existing records and outreach history are preserved."
        onClose={() => {
          if (!busy) setPreview(null);
        }}
        footer={
          <>
            <Button tone="quiet" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void choose()}>
              Choose another CSV
            </Button>
            <Button
              tone="primary"
              loading={busy}
              disabled={
                !preview ||
                preview.errors.length > 0 ||
                (preview.newInvestors === 0 && preview.newPeople === 0)
              }
              onClick={() => void importRows()}
            >
              Import reviewed rows
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="csv-import-preview">
            <p>
              <strong>Rows: {preview.totalRows}</strong> · Investors to add: {preview.newInvestors}.{' '}
              People to add: {preview.newPeople}. Existing rows to keep: {preview.skippedRows}.
            </p>
            <p>
              Use a <code>name</code> column for the investor. Optional columns: type, website,
              headquarters, description, person_name, title, work_email, individual_email. UTF-8
              CSV, up to 2,000 rows and 5 MiB.
            </p>
            {preview.ignoredColumns.length ? (
              <p>Columns not imported: {preview.ignoredColumns.join(', ')}.</p>
            ) : null}
            {preview.errors.length ? (
              <div role="alert">
                <strong>
                  Correct {preview.errors.length} invalid{' '}
                  {preview.errors.length === 1 ? 'row' : 'rows'}, then choose the file again.
                </strong>
                <ul>
                  {preview.errors.slice(0, 100).map((error) => (
                    <li key={`${error.row}:${error.message}`}>
                      Row {error.row}: {error.message}
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 100 ? <p>Showing the first 100 errors.</p> : null}
              </div>
            ) : null}
            <div className="csv-import-preview__table">
              <table>
                <caption>Import preview (up to 50 rows)</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Investor</th>
                    <th scope="col">Person</th>
                    <th scope="col">Email</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td>{row.name}</td>
                      <td>{row.personName ?? '—'}</td>
                      <td>{row.email ?? '—'}</td>
                      <td>
                        {row.action === 'add'
                          ? 'Add'
                          : row.action === 'skip'
                            ? 'Keep existing'
                            : 'Correct row'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
