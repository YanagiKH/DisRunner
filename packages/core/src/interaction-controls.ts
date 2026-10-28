import { cloneInteractionPayload } from './interaction-message-domain.js';
import { DiscordApiError } from './interactions.js';

/** Legacy modal rows contain one labelled text input each; newer modal controls are separate. */
export function validateLegacyModalResponse(
  value: unknown,
  maxBytes = 1_048_576,
): Readonly<Record<string, unknown>> {
  const data = object(clone(value, maxBytes));
  keys(data, ['custom_id', 'title', 'components'], ['custom_id', 'title', 'components']);
  text(data['custom_id'], 1, 100);
  text(data['title'], 1, 45);
  const customIds = new Set<string>();
  const componentIds = new Set<number>();
  const componentId = (component: Record<string, unknown>): void => {
    if (!Object.hasOwn(component, 'id')) return;
    const id = integer(component['id'], 0, 4_294_967_295);
    if (id !== 0 && componentIds.has(id)) invalid();
    if (id !== 0) componentIds.add(id);
  };
  for (const entry of array(data['components'], 1, 5)) {
    const row = object(entry);
    keys(row, ['type', 'id', 'components'], ['type', 'components']);
    if (row['type'] !== 1) invalid();
    componentId(row);
    const input = object(array(row['components'], 1, 1)[0]);
    keys(
      input,
      [
        'type',
        'id',
        'custom_id',
        'style',
        'label',
        'required',
        'min_length',
        'max_length',
        'value',
        'placeholder',
      ],
      ['type', 'custom_id', 'style', 'label'],
    );
    if (input['type'] !== 4 || (input['style'] !== 1 && input['style'] !== 2)) invalid();
    componentId(input);
    const customId = text(input['custom_id'], 1, 100);
    if (customIds.has(customId)) invalid();
    customIds.add(customId);
    text(input['label'], 1, 45);
    if (Object.hasOwn(input, 'required') && typeof input['required'] !== 'boolean') invalid();
    const minimum = Object.hasOwn(input, 'min_length') ? integer(input['min_length'], 0, 4000) : 0;
    const maximum = Object.hasOwn(input, 'max_length')
      ? integer(input['max_length'], 1, 4000)
      : 4000;
    if (minimum > maximum) invalid();
    if (Object.hasOwn(input, 'value')) text(input['value'], 0, 4000);
    if (Object.hasOwn(input, 'placeholder')) text(input['placeholder'], 0, 100);
  }
  return data;
}

/** Response choice type follows the focused option, when the caller has that command context. */
export function validateAutocompleteResponse(
  value: unknown,
  maxBytes = 1_048_576,
  focusedOptionType?: number,
): Readonly<Record<string, unknown>> {
  if (focusedOptionType !== undefined && ![3, 4, 10].includes(focusedOptionType)) invalid();
  const data = object(clone(value, maxBytes));
  keys(data, ['choices'], ['choices']);
  for (const entry of array(data['choices'], 0, 25)) {
    const choice = object(entry);
    keys(choice, ['name', 'value'], ['name', 'value']);
    text(choice['name'], 1, 100);
    const selected = choice['value'];
    if (typeof selected === 'string') {
      text(selected, 0, 100);
      if (focusedOptionType !== undefined && focusedOptionType !== 3) invalid();
    } else if (typeof selected === 'number' && Number.isFinite(selected)) {
      if (focusedOptionType === 3 || (focusedOptionType === 4 && !Number.isSafeInteger(selected)))
        invalid();
    } else invalid();
  }
  return data;
}

/** Locate the single focused leaf through slash-command groups/subcommands. */
export function findFocusedAutocompleteOptionType(
  value: unknown,
  maxBytes = 1_048_576,
): number | undefined {
  const data = object(clone(value, maxBytes));
  let focused: number | undefined;
  const visit = (options: unknown): void => {
    if (options === undefined) return;
    for (const entry of array(options, 0, 25)) {
      const option = object(entry);
      if (Object.hasOwn(option, 'focused') && typeof option['focused'] !== 'boolean') invalid();
      if (option['focused'] === true) {
        const type = option['type'];
        if (typeof type !== 'number' || ![3, 4, 10].includes(type) || focused !== undefined)
          invalid();
        focused = type;
      }
      visit(option['options']);
    }
  };
  visit(data['options']);
  return focused;
}

function clone(value: unknown, maxBytes: number): unknown {
  try {
    return cloneInteractionPayload(value, maxBytes);
  } catch {
    invalid();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  permitted: readonly string[],
  required: readonly string[] = [],
): void {
  if (
    Object.keys(value).some((key) => !permitted.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value as unknown[];
}
function text(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}
function invalid(): never {
  throw new DiscordApiError(400, 50035, 'Invalid interaction control payload.');
}
