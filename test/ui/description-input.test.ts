import { render } from '@inquirer/testing';
import { describe, expect, test, vi } from 'vitest';
import { descriptionInput } from '../../src/ui/description-input.js';

describe('descriptionInput', () => {
  test('shows the description under the message and returns the default on Enter', async () => {
    const { answer, events, getScreen } = await render(descriptionInput, {
      message: 'Remote port',
      description: 'Port of the service on the instance',
      default: '22',
    });
    expect(getScreen()).toContain('Port of the service on the instance');
    expect(getScreen()).toContain('(22)');
    events.keypress('enter');
    expect(await answer).toBe('22');
  });

  test('Tab fills the default into the input', async () => {
    const { answer, events, getScreen } = await render(descriptionInput, {
      message: 'Remote port',
      description: 'desc',
      default: '22',
    });
    events.keypress('tab');
    await vi.waitFor(() => expect(getScreen()).not.toContain('(22)'));
    events.type('0');
    events.keypress('enter');
    expect(await answer).toBe('220');
  });

  test('validate message is shown and the prompt stays open', async () => {
    const { answer, events, getScreen } = await render(descriptionInput, {
      message: 'Port',
      description: 'desc',
      validate: (v: string) => (v === 'ok' ? true : 'Only ok is accepted'),
    });
    events.type('no');
    events.keypress('enter');
    await vi.waitFor(() => expect(getScreen()).toContain('Only ok is accepted'));
    events.keypress('backspace');
    events.keypress('backspace');
    events.type('ok');
    events.keypress('enter');
    expect(await answer).toBe('ok');
  });

  test('required without a default rejects an empty answer', async () => {
    const { answer, events, getScreen } = await render(descriptionInput, {
      message: 'Name',
      description: 'desc',
      required: true,
    });
    events.keypress('enter');
    await vi.waitFor(() => expect(getScreen()).toContain('You must provide a value'));
    events.type('x');
    events.keypress('enter');
    expect(await answer).toBe('x');
  });
});

describe('descriptionInput after the answer', () => {
  test('collapses to the answered line and drops the description', async () => {
    const { answer, events, getScreen } = await render(descriptionInput, {
      message: 'Remote service port',
      description: 'Port of the service on the remote host.',
      default: '5432',
    });
    events.keypress('enter');
    expect(await answer).toBe('5432');
    expect(getScreen()).toContain('Remote service port');
    expect(getScreen()).toContain('5432');
    expect(getScreen()).not.toContain('Port of the service on the remote host.');
  });
});
