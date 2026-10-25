import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageFeed } from './MessageFeed';
import { ModalDialog } from './ModalDialog';

describe('real message interaction controls', () => {
  it('saves a displayed attachment by its local ID', async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageFeed
        channelName="test"
        onSaveAttachment={save}
        messages={[
          {
            id: 'm',
            author: 'Bot',
            authorRole: 'bot',
            content: 'File',
            time: 'now',
            attachments: [{ id: 'attachment-1', filename: 'note.txt', size: 12 }],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save note.txt' }));
    expect(save).toHaveBeenCalledExactlyOnceWith('attachment-1');
  });
  it('dispatches a button with its message identity and blocks disabled and link buttons', async () => {
    const action = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageFeed
        channelName="test"
        onAction={action}
        messages={[
          {
            id: 'message-a',
            author: 'Bot',
            authorRole: 'bot',
            content: 'Choose',
            time: 'now',
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 1, label: 'Confirm', custom_id: 'confirm' },
                  { type: 2, style: 1, label: 'Disabled', custom_id: 'disabled', disabled: true },
                  { type: 2, style: 5, label: 'Website', url: 'https://example.com' },
                ],
              },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(action).toHaveBeenCalledExactlyOnceWith({
      type: 'component',
      componentType: 2,
      messageId: 'message-a',
      customId: 'confirm',
    });
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Website ↗' })).toBeDisabled();
  });
  it('enforces select bounds before dispatching the selected values', async () => {
    const action = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageFeed
        channelName="test"
        onAction={action}
        messages={[
          {
            id: 'm',
            author: 'Bot',
            authorRole: 'bot',
            content: 'Select',
            time: 'now',
            components: [
              {
                type: 3,
                custom_id: 'items',
                min_values: 2,
                max_values: 2,
                options: [
                  { label: 'One', value: 'one' },
                  { label: 'Two', value: 'two' },
                ],
              },
            ],
          },
        ]}
      />,
    );
    const select = screen.getByRole('listbox');
    await user.selectOptions(select, ['one']);
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled();
    await user.selectOptions(select, ['two']);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(action).toHaveBeenCalledWith({
      type: 'component',
      componentType: 3,
      messageId: 'm',
      customId: 'items',
      values: ['one', 'two'],
    });
  });
  it('does not submit a cancelled modal and submits declared text fields once', async () => {
    const submit = vi.fn(() => Promise.resolve(undefined));
    const cancel = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <ModalDialog
        data={{
          title: 'Profile',
          custom_id: 'profile',
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: 'name', label: 'Name', required: true }],
            },
          ],
        }}
        onCancel={cancel}
        onSubmit={submit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    unmount();
    render(
      <ModalDialog
        data={{
          title: 'Profile',
          custom_id: 'profile',
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: 'name', label: 'Name', required: true }],
            },
          ],
        }}
        onCancel={cancel}
        onSubmit={submit}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Ada' } });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith({ name: 'Ada' });
  });
});
