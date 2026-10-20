import { classificationPutSchema, hasClassification, type AssetClass, type ClassificationFields, type ClassificationInstrument, type ClassificationValues } from '@portfolio/shared';
import { FIELD_LABELS } from './labels';

export interface ClassificationForm {
  name: string;
  assetClass: AssetClass;
  sector: string;
  country: string;
}

/** The form starts at what the screens show today (the override where there is one). */
export function initialForm({ effective }: Pick<ClassificationInstrument, 'effective'>): ClassificationForm {
  return { name: effective.name, assetClass: effective.assetClass, sector: effective.sector ?? '', country: effective.country ?? '' };
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
  const label = typeof field === 'string' && field in FIELD_LABELS ? FIELD_LABELS[field as keyof typeof FIELD_LABELS] : 'Classification';
  return `${label}: ${issue.message}`;
}
