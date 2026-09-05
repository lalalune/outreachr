import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { OnboardingFlow } from '../../src/renderer/src/pages/OnboardingFlow';
import { WorkspaceProvider } from '../../src/renderer/src/state/WorkspaceContext';
import { bootstrapFixture, installBridge } from './fixtures';

it('shows setup failures before the app shell exists and lets the founder retry the same form', async () => {
  const command = vi
    .fn()
    .mockRejectedValueOnce(new Error('The local vault could not be saved.'))
    .mockResolvedValueOnce(bootstrapFixture());
  installBridge({ ...bootstrapFixture(), isFirstRun: true }, command as never);
  render(
    <WorkspaceProvider>
      <OnboardingFlow />
    </WorkspaceProvider>,
  );
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Test Founder' } });
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'founder@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Test Company' } });
  fireEvent.change(screen.getByLabelText('One-line description'), {
    target: { value: 'Synthetic local onboarding validation.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    screen.getByText(/Google Desktop clients also use the dedicated client secret field/u),
  ).toBeVisible();
  const finish = screen.getByRole('button', { name: 'Create local workspace' });
  fireEvent.click(finish);
  expect(await screen.findByRole('alert')).toHaveTextContent('The local vault could not be saved.');
  expect(finish).toBeEnabled();
  fireEvent.click(finish);
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
});

it.each(['founder@@example.test', 'founder@example.test.', 'founder@.example.test'])(
  'keeps the founder step open for an email the command boundary rejects: %s',
  (email) => {
    installBridge({ ...bootstrapFixture(), isFirstRun: true });
    render(
      <WorkspaceProvider>
        <OnboardingFlow />
      </WorkspaceProvider>,
    );
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Test Founder' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'founder@example.test' },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  },
);
