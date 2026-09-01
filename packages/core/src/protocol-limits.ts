import type { SimulationMode } from './contracts.js';

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
  LOADING: 1 << 7,
  IS_COMPONENTS_V2: 1 << 15,
} as const;

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export class DiscordValidationError extends Error {
  public readonly code = 50035;
  public readonly issues: readonly ValidationIssue[];
  public constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'DiscordValidationError';
    this.issues = issues;
  }
}

const MAX_COMPONENT_DEPTH = 16;
const MAX_COMPONENT_SCAN_NODES = 1_000;

export function validateMessagePayload(
  payload: Readonly<Record<string, unknown>>,
  mode: SimulationMode = 'strict',
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const report = (issue: ValidationIssue): void => {
    if (mode === 'strict') issues.push(issue);
    else warnings.push(issue);
  };

  const content = payload['content'];
  if (content !== undefined && typeof content !== 'string') {
    report(issue('content', 'BASE_TYPE_BAD_TYPE', 'Content must be a string.'));
  } else if (typeof content === 'string' && content.length > 2_000) {
    report(issue('content', 'BASE_TYPE_MAX_LENGTH', 'Content cannot exceed 2,000 characters.'));
  }

  const embeds = arrayField(payload, 'embeds', report);
  if (embeds.length > 10)
    report(issue('embeds', 'BASE_TYPE_MAX_LENGTH', 'A message can contain at most 10 embeds.'));
  let embedTextLength = 0;
  embeds.slice(0, 10).forEach((embed, index) => {
    if (!isRecord(embed)) {
      report(issue(`embeds.${index}`, 'BASE_TYPE_BAD_TYPE', 'Embed must be an object.'));
      return;
    }
    embedTextLength += validateEmbed(embed, index, report);
  });
  if (embedTextLength > 6_000) {
    report(
      issue(
        'embeds',
        'EMBED_TOTAL_MAX_LENGTH',
        'Combined embed text cannot exceed 6,000 characters.',
      ),
    );
  }

  const attachments = arrayField(payload, 'attachments', report);
  if (attachments.length > 10) {
    report(
      issue('attachments', 'BASE_TYPE_MAX_LENGTH', 'A message can contain at most 10 attachments.'),
    );
  }
  const components = arrayField(payload, 'components', report);
  const componentCount = validateComponents(components, report);
  const flags = numericFlags(payload['flags']);
  const isV2 = (flags & MessageFlags.IS_COMPONENTS_V2) !== 0;
  if (isV2) {
    if (typeof content === 'string' && content.length > 0) {
      report(
        issue(
          'content',
          'COMPONENT_V2_CONTENT_CONFLICT',
          'Components V2 messages cannot use content.',
        ),
      );
    }
    if (embeds.length > 0) {
      report(
        issue(
          'embeds',
          'COMPONENT_V2_CONTENT_CONFLICT',
          'Components V2 messages cannot use embeds.',
        ),
      );
    }
    if (componentCount > 40) {
      report(
        issue(
          'components',
          'COMPONENT_MAX_COUNT',
          'Components V2 messages can contain at most 40 components.',
        ),
      );
    }
  } else {
    if (components.length > 5) {
      report(
        issue(
          'components',
          'BASE_TYPE_MAX_LENGTH',
          'Legacy messages can contain at most 5 action rows.',
        ),
      );
    }
    const rowsToInspect = Math.min(components.length, MAX_COMPONENT_SCAN_NODES);
    for (let rowIndex = 0; rowIndex < rowsToInspect; rowIndex += 1) {
      const component = components[rowIndex];
      if (
        isRecord(component) &&
        Array.isArray(component['components']) &&
        component['components'].length > 5
      ) {
        report(
          issue(
            `components.${rowIndex}.components`,
            'BASE_TYPE_MAX_LENGTH',
            'A legacy action row can contain at most 5 components.',
          ),
        );
      }
    }
  }
  return { valid: issues.length === 0, issues, warnings };
}

export function assertValidMessagePayload(
  payload: Readonly<Record<string, unknown>>,
  mode: SimulationMode = 'strict',
): ValidationResult {
  const result = validateMessagePayload(payload, mode);
  if (!result.valid) throw new DiscordValidationError(result.issues);
  return result;
}

function validateEmbed(
  embed: Readonly<Record<string, unknown>>,
  index: number,
  report: (issue: ValidationIssue) => void,
): number {
  let total = 0;
  total += validateTextField(embed, 'title', 256, `embeds.${index}.title`, report);
  total += validateTextField(embed, 'description', 4_096, `embeds.${index}.description`, report);
  const footer = embed['footer'];
  if (isRecord(footer))
    total += validateTextField(footer, 'text', 2_048, `embeds.${index}.footer.text`, report);
  const author = embed['author'];
  if (isRecord(author))
    total += validateTextField(author, 'name', 256, `embeds.${index}.author.name`, report);
  const fields = embed['fields'];
  if (Array.isArray(fields)) {
    if (fields.length > 25) {
      report(
        issue(
          `embeds.${index}.fields`,
          'BASE_TYPE_MAX_LENGTH',
          'An embed can contain at most 25 fields.',
        ),
      );
    }
    fields.slice(0, 25).forEach((field, fieldIndex) => {
      if (!isRecord(field)) return;
      total += validateTextField(
        field,
        'name',
        256,
        `embeds.${index}.fields.${fieldIndex}.name`,
        report,
      );
      total += validateTextField(
        field,
        'value',
        1_024,
        `embeds.${index}.fields.${fieldIndex}.value`,
        report,
      );
    });
  }
  return total;
}

function validateTextField(
  object: Readonly<Record<string, unknown>>,
  field: string,
  maxLength: number,
  path: string,
  report: (issue: ValidationIssue) => void,
): number {
  const value = object[field];
  if (value === undefined) return 0;
  if (typeof value !== 'string') {
    report(issue(path, 'BASE_TYPE_BAD_TYPE', 'Value must be a string.'));
    return 0;
  }
  if (value.length > maxLength) {
    report(issue(path, 'BASE_TYPE_MAX_LENGTH', `Value cannot exceed ${maxLength} characters.`));
  }
  return value.length;
}

function validateComponents(
  components: readonly unknown[],
  report: (issue: ValidationIssue) => void,
): number {
  const seen = new Set<string>();
  const visited = new WeakSet<object>();
  const stack: { readonly component: unknown; readonly path: string; readonly depth: number }[] =
    [];
  let count = 0;
  let budgetReported = false;
  const reportBudget = (): void => {
    if (budgetReported) return;
    report(
      issue(
        'components',
        'COMPONENT_SCAN_LIMIT',
        `Component validation cannot exceed ${MAX_COMPONENT_SCAN_NODES} nodes.`,
      ),
    );
    budgetReported = true;
  };
  if (components.length > MAX_COMPONENT_SCAN_NODES) reportBudget();
  const rootCount = Math.min(components.length, MAX_COMPONENT_SCAN_NODES);
  for (let index = rootCount - 1; index >= 0; index -= 1) {
    stack.push({ component: components[index], path: `components.${index}`, depth: 1 });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    count += 1;
    if (count > MAX_COMPONENT_SCAN_NODES) {
      reportBudget();
      break;
    }
    const { component, path, depth } = current;
    if (!isRecord(component)) continue;
    if (visited.has(component)) {
      report(issue(path, 'COMPONENT_CYCLE', 'Components cannot contain object cycles.'));
      continue;
    }
    visited.add(component);
    const customId = component['custom_id'];
    if (customId !== undefined) {
      if (typeof customId !== 'string' || customId.length < 1 || customId.length > 100) {
        report(
          issue(
            `${path}.custom_id`,
            'COMPONENT_CUSTOM_ID_LENGTH',
            'custom_id must contain 1 to 100 characters.',
          ),
        );
      } else if (seen.has(customId)) {
        report(
          issue(`${path}.custom_id`, 'CUSTOM_ID_COLLISION', `Duplicate custom_id ${customId}.`),
        );
      } else {
        seen.add(customId);
      }
    }
    const children = component['components'];
    if (Array.isArray(children)) {
      if (depth >= MAX_COMPONENT_DEPTH) {
        report(
          issue(
            `${path}.components`,
            'COMPONENT_MAX_DEPTH',
            `Components cannot be nested deeper than ${MAX_COMPONENT_DEPTH} levels.`,
          ),
        );
        continue;
      }
      const available = Math.max(0, MAX_COMPONENT_SCAN_NODES - count - stack.length);
      if (children.length > available) reportBudget();
      const childCount = Math.min(children.length, available);
      for (let index = childCount - 1; index >= 0; index -= 1) {
        stack.push({
          component: children[index],
          path: `${path}.components.${index}`,
          depth: depth + 1,
        });
      }
    }
  }
  return count;
}

function arrayField(
  payload: Readonly<Record<string, unknown>>,
  field: string,
  report: (issue: ValidationIssue) => void,
): readonly unknown[] {
  const value = payload[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report(issue(field, 'BASE_TYPE_BAD_TYPE', `${field} must be an array.`));
    return [];
  }
  return value;
}

function numericFlags(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
