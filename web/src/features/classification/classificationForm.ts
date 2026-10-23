import { classificationPutSchema, hasClassification, type AssetClass, type ClassificationFields, type ClassificationInstrument, type ClassificationValues, type KpiTemplateId } from '@portfolio/shared';
import { FIELD_LABELS } from './labels';

export interface ClassificationForm {
  name: string;
  assetClass: AssetClass;
  sector: string;
  country: string;
  /** Website domain the company logo is looked up by; empty = detected automatically. */
  domain: string;
  /** The earnings summary template; empty = automatic (the table of known tickers, then the sector). */
  kpiTemplate: KpiTemplateId | '';
}

/** What the domain input is called in the dialog and in validation messages. */
export const DOMAIN_LABEL = 'Website domain';
/** What the template select is called in the dialog and in validation messages. */
export const KPI_TEMPLATE_LABEL = 'Earnings template';

/** The form starts at what the screens show today (the override where there is one). */
export function initialForm({ effective, override }: Pick<ClassificationInstrument, 'effective'> & Partial<Pick<ClassificationInstrument, 'override'>>): ClassificationForm {
  return { name: effective.name, assetClass: effective.assetClass, sector: effective.sector ?? '', country: effective.country ?? '', domain: override?.domain ?? '', kpiTemplate: override?.kpiTemplate ?? '' };
}

/**
 * The override to store: only the fields whose value differs from the automatic one, so what is stored stays minimal and every other
 * field keeps following the profile. A field left empty, or typed back to the automatic value, is not overridden.
 */
export function fieldsToSend(form: ClassificationForm, base: ClassificationValues): ClassificationFields {
  const fields: ClassificationFields = {};
  const name = form.name.trim();
  const sector = form.sector.trim();
  const country = form.country.trim();
  if (name !== '' && name !== base.name) fields.name = name;
  if (form.assetClass !== base.assetClass) fields.assetClass = form.assetClass;
  if (sector !== '' && sector !== base.sector) fields.sector = sector;
  if (country !== '' && country !== base.country) fields.country = country;
  // The domain has no automatic counterpart to compare with: what is typed is what is stored, empty means detect it.
  const domain = form.domain.trim();
  if (domain !== '') fields.domain = domain;
  if (form.kpiTemplate !== '') fields.kpiTemplate = form.kpiTemplate;
  return fields;
}

export const NOTHING_TO_SAVE = 'Change at least one value first. To go back to the automatic values, use "Reset to automatic".';

/** The first problem the API would refuse the fields for, in words, or null. */
export function validateFields(fields: ClassificationFields): string | null {
  if (!hasClassification(fields)) return NOTHING_TO_SAVE;
  const parsed = classificationPutSchema.safeParse(fields);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]!;
  const field = issue.path[0];
  const label = fieldLabel(field);
  return `${label}: ${issue.message}`;
}

function fieldLabel(field: unknown): string {
  if (field === 'domain') return DOMAIN_LABEL;
  if (field === 'kpiTemplate') return KPI_TEMPLATE_LABEL;
  return typeof field === 'string' && field in FIELD_LABELS ? FIELD_LABELS[field as keyof typeof FIELD_LABELS] : 'Classification';
}
