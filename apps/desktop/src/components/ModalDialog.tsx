import { useEffect, useRef, useState } from 'react';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function inputs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((component: unknown) =>
    record(component)
      ? component['type'] === 4
        ? [component]
        : inputs(component['components'])
      : [],
  );
}
export function ModalDialog({
  data,
  onCancel,
  onSubmit,
}: {
  readonly data: Readonly<Record<string, unknown>>;
  readonly onCancel: () => void;
  readonly onSubmit: (fields: Readonly<Record<string, string>>) => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fields = inputs(data['components']);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        String(field['custom_id']),
        typeof field['value'] === 'string' ? field['value'] : '',
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    container.current?.querySelector<HTMLElement>('input,textarea,button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className="interaction-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="interaction-modal-title"
        ref={container}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const nodes = container.current?.querySelectorAll<HTMLElement>(
              'input,textarea,button:not(:disabled)',
            );
            if (nodes?.length) {
              const first = nodes[0];
              const last = nodes[nodes.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }
        }}
      >
        <h2 id="interaction-modal-title">
          {typeof data['title'] === 'string' ? data['title'] : 'Bot form'}
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void onSubmit(values).finally(() => setBusy(false));
          }}
        >
          {fields.map((field) => {
            const id = String(field['custom_id']);
            const label = typeof field['label'] === 'string' ? field['label'] : id;
            const props = {
              id: `modal-${id}`,
              name: id,
              required: field['required'] !== false,
              minLength: typeof field['min_length'] === 'number' ? field['min_length'] : undefined,
              maxLength: typeof field['max_length'] === 'number' ? field['max_length'] : 4000,
              placeholder:
                typeof field['placeholder'] === 'string' ? field['placeholder'] : undefined,
              value: values[id] ?? '',
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setValues({ ...values, [id]: event.target.value }),
            };
            return (
              <label key={id} htmlFor={`modal-${id}`}>
                {label}
                {field['style'] === 2 ? <textarea {...props} /> : <input {...props} />}
              </label>
            );
          })}
          <div className="project-toolbar">
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="primary-action" disabled={busy || fields.length === 0}>
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
