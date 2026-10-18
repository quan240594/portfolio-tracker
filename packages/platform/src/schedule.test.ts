import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULED_JOBS, toAwsCron } from './schedule.js';

const TERRAFORM = join(__dirname, '../../../infra/terraform');
const terraform = readdirSync(TERRAFORM)
  .filter((file) => file.endsWith('.tf'))
  .map((file) => readFileSync(join(TERRAFORM, file), 'utf8'))
  .join('\n');

/** The `{ ... }` block that follows `header` (Terraform blocks here contain no nested unbalanced braces in strings). */
function block(header: string): string {
  const start = terraform.indexOf(header);
  expect(start, `${header} not found in infra/terraform`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = terraform.indexOf('{', start); i < terraform.length; i++) {
    if (terraform[i] === '{') depth++;
    if (terraform[i] === '}' && --depth === 0) return terraform.slice(start, i + 1);
  }
  throw new Error(`Unterminated block ${header}`);
}

const variableDefault = (name: string): string => /default\s*=\s*"([^"]*)"/.exec(block(`variable "${name}"`))![1]!;

/** `jsonencode({ trigger = "scheduled" })` / `jsonencode({ all = true })` as an object. */
function jsonencoded(input: string): unknown {
  const body = /jsonencode\(\{([^}]*)\}\)/.exec(input)![1]!;
  const entries = body.split(',').map((pair) => pair.split('=').map((part) => part.trim()));
  return Object.fromEntries(entries.map(([key, value]) => [key, value === 'true' ? true : value!.replaceAll('"', '')]));
}

describe('SCHEDULED_JOBS matches infra/terraform', () => {
  const resourceNames = [...terraform.matchAll(/resource "aws_scheduler_schedule" "([a-z_]+)"/g)].map((m) => m[1]!);

  it('declares exactly the schedules Terraform creates', () => {
    expect(resourceNames.sort((a, b) => a.localeCompare(b))).toEqual(SCHEDULED_JOBS.map((s) => s.name.replaceAll('-', '_')).sort((a, b) => a.localeCompare(b)));
  });

  it.each(SCHEDULED_JOBS.map((s) => [s.name, s] as const))('%s: name, cron, time zone and payload', (_name, job) => {
    const schedule = block(`resource "aws_scheduler_schedule" "${job.name.replaceAll('-', '_')}"`);
    expect(schedule).toContain(`name                         = "\${local.app}-${job.name}-\${var.env}"`);

    const expression = /schedule_expression\s*=\s*var\.(\w+)/.exec(schedule)![1]!;
    expect(variableDefault(expression)).toBe(toAwsCron(job));

    const timezone = /schedule_expression_timezone\s*=\s*var\.(\w+)/.exec(schedule)![1]!;
    expect(variableDefault(timezone)).toBe(job.timezone);

    const input = /input\s*=\s*(jsonencode\(.*\))/.exec(schedule)![1]!;
    expect(jsonencoded(input)).toEqual(job.payload);
  });
});
