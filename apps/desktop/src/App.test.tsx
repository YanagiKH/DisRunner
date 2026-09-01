import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('DisRunner desktop shell', () => {
  it('starts the bot and executes an ephemeral slash command from the composer', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Start bot' }));
    expect(screen.getByText('Running')).toBeInTheDocument();

    const composer = screen.getByRole('textbox', { name: 'Message #bot-testing' });
    await user.type(composer, '/secret{Enter}');

    expect(screen.getAllByText('Only you can see this.').length).toBeGreaterThan(1);
    expect(screen.getByRole('tab', { name: 'Payload' })).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates to a full workspace surface and back to the simulator', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Risk Center' }));
    expect(screen.getByRole('heading', { name: 'Risk Center' })).toBeInTheDocument();
    expect(screen.getByText('INTERACTION_TIMEOUT')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to simulator' }));
    expect(screen.getByRole('main', { name: 'Virtual channel bot-testing' })).toBeInTheDocument();
  });

  it('labels sample evidence and disables controls that cannot persist or execute', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText('Visual preview shell')).toBeInTheDocument();
    expect(screen.getByText('Visual preview · sample panels')).toBeInTheDocument();
    expect(screen.queryByText('Live', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile preview · Strict' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Virtual time playback unavailable' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Guild Editor' }));
    expect(screen.getByRole('button', { name: 'Save unavailable' })).toBeDisabled();
    expect(screen.getByText('Sample data')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Scenario Lab' }));
    expect(screen.getByRole('button', { name: 'Run unavailable' })).toBeDisabled();
    expect(screen.getByText('No scenario has run in this screen')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Command Explorer' }));
    expect(screen.getByRole('button', { name: 'Invoke selected name' })).toBeDisabled();
    expect(screen.getByText('Sample · Guild · v4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Risk Center' }));
    expect(screen.getByRole('button', { name: 'Export unavailable' })).toBeDisabled();
    expect(screen.getByText('Sample findings')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Persistence unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable Audit blocked requests' })).toBeDisabled();
  });
});
