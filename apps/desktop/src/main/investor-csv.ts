import { z } from 'zod';

export const MAX_CSV_ROWS = 2_000;
export type InvestorCsvRow = z.infer<typeof rowSchema> & { row: number };
export interface CsvRowError {
  row: number;
  message: string;
}

const rowSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    kind: z.enum([
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
    ]),
    website: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }, 'Use a complete, credential-free HTTPS website URL')
      .optional(),
    headquarters: z.string().max(1000).optional(),
    description: z.string().max(100_000).optional(),
    personName: z.string().trim().min(1).max(500).optional(),
    title: z.string().max(500).optional(),
    workEmail: z.string().email().max(320).optional(),
    personalEmail: z.string().email().max(320).optional(),
  })
  .refine((row) => row.personName || !(row.title || row.workEmail || row.personalEmail), {
    message: 'person_name is required when a title or email is supplied',
  });

// Bounded RFC 4180 reader: commas, escaped quotes, CRLF and quoted newlines.
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = (): void => {
    row.push(field);
    if (row.length > 64) throw new Error('CSV has more than 64 columns');
    field = '';
    closedQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    records.push(row);
    if (records.length > MAX_CSV_ROWS + 1) throw new Error(`CSV exceeds ${MAX_CSV_ROWS} data rows`);
    row = [];
  };
  const value = text.replace(/^\uFEFF/u, '');
  if (value.includes('\0')) throw new Error('CSV contains a NUL character');
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += char;
    } else if (char === ',') finishField();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && value[index + 1] === '\n') index += 1;
      finishRow();
    } else if (closedQuote)
      throw new Error(`Unexpected character after closing quote in CSV row ${records.length + 1}`);
    else if (char === '"') {
      if (field) throw new Error(`Unexpected quote in CSV row ${records.length + 1}`);
      quoted = true;
    } else field += char;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field || row.length || closedQuote) finishRow();
  return records;
}

export function parseInvestorCsv(text: string): {
  rows: InvestorCsvRow[];
  errors: CsvRowError[];
  totalRows: number;
  ignoredColumns: string[];
} {
  const records = csvRecords(text);
  const header = records.shift();
  if (!header || !records.some((record) => record.some((value) => value.trim())))
    throw new Error('CSV needs a header and at least one data row');
  const aliases: Record<string, string> = {
    firm_name: 'name',
    investor_name: 'name',
    firm: 'name',
    investor: 'name',
    investor_type: 'kind',
    type: 'kind',
    person_name: 'personName',
    contact_name: 'personName',
    work_email: 'workEmail',
    email: 'workEmail',
    individual_email: 'personalEmail',
    personal_email: 'personalEmail',
  };
  const columns = header.map((value) => {
    const key = value.trim().toLowerCase().replace(/[ -]+/gu, '_');
    return Object.hasOwn(aliases, key) ? aliases[key]! : key;
  });
  if (!columns.includes('name'))
    throw new Error('CSV requires a name (firm or investor name) column');
  if (new Set(columns).size !== columns.length)
    throw new Error('CSV has duplicate or ambiguous column headers');
  const supported = new Set([
    'name',
    'kind',
    'website',
    'headquarters',
    'description',
    'personName',
    'title',
    'workEmail',
    'personalEmail',
  ]);
  const ignoredColumns = header.filter((_, index) => !supported.has(columns[index]!));
  const rows: InvestorCsvRow[] = [];
  const errors: CsvRowError[] = [];
  records.forEach((record, index) => {
    if (record.every((value) => !value.trim())) return;
    const row = index + 2;
    if (record.length !== columns.length) {
      errors.push({ row, message: `Expected ${columns.length} columns; found ${record.length}` });
      return;
    }
    const input: Record<string, string> = { kind: 'venture_capital' };
    columns.forEach((column, columnIndex) => {
      const value = record[columnIndex]!.trim();
      if (supported.has(column) && value) input[column] = value;
    });
    const parsed = rowSchema.safeParse(input);
    if (!parsed.success)
      errors.push({
        row,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
    else rows.push({ ...parsed.data, row });
  });
  return {
    rows,
    errors,
    totalRows: records.filter((record) => record.some((value) => value.trim())).length,
    ignoredColumns,
  };
}
