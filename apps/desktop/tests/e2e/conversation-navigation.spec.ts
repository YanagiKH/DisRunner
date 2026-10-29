import { expect, test } from '@playwright/test';

interface NavigationRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly context: {
    readonly actorId: string;
    readonly guildId?: string;
    readonly channelId: string;
  };
  readonly action: { readonly type: string; readonly content?: string };
}

declare global {
  interface Window {
    readonly navigationRequests?: readonly NavigationRequest[];
    readonly navigationControls?: { stop: number; window: string[] };
  }
}

for (const width of [720, 851, 1025, 1081, 1241, 1280, 1321, 1441]) {
  test(`keeps guild channels and direct messages reachable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 720 });
    await page.addInitScript(() => {
      const actorId = '3000';
      const resources = [
        { resourceType: 'guild', id: '1000', name: 'Navigation Lab' },
        { resourceType: 'guild', id: '1100', name: 'Other Lab' },
        { resourceType: 'channel', id: '2000', guild_id: '1000', type: 0, name: 'first' },
        { resourceType: 'channel', id: '2100', guild_id: '1000', type: 0, name: 'second' },
        { resourceType: 'channel', id: '2200', guild_id: '1100', type: 0, name: 'other' },
        { resourceType: 'channel', id: '9000', type: 1, name: 'Direct test' },
        { resourceType: 'user', id: actorId, username: 'Developer', bot: false },
      ];
      const snapshot = {
        schemaVersion: 1,
        sessionId: 'navigation-session',
        runId: 'navigation-run',
        revision: 1,
        disposed: false,
        phase: 'running',
        contexts: [
          { actorId, guildId: '1000', channelId: '2000' },
          { actorId, guildId: '1000', channelId: '2100' },
          { actorId, guildId: '1100', channelId: '2200' },
          { actorId, channelId: '9000' },
        ],
        project: {
          root: '/project',
          configPath: '/project/config.json',
          botName: 'Navigation Bot',
          executable: 'node',
          args: [],
          cwd: '/project',
          adapter: 'raw',
          mode: 'strict',
          seed: 42042,
          environmentNames: [],
        },
        error: null,
        pid: 123,
        endpoints: null,
        output: [],
        traces: [],
        risks: [],
        commands: [],
        coreState: {
          schemaVersion: 1,
          runId: 'navigation-run',
          stateRevision: 1,
          revisioned: true,
          clock: { domain: 'bot', mode: 'realtime', nowMs: 1 },
          resources,
          totalResources: resources.length,
          truncated: false,
          evidenceComplete: true,
        },
      };
      const requests: NavigationRequest[] = [];
      const controls = { stop: 0, window: [] as string[] };
      Object.defineProperty(window, 'navigationRequests', { value: requests });
      Object.defineProperty(window, 'navigationControls', { value: controls });
      Object.defineProperty(window, 'disrunnerDesktop', {
        value: {
          getRuntimeInfo: () =>
            Promise.resolve({ platform: 'linux', version: 'test', packaged: false, offline: true }),
          getRuntimeState: (actor?: string) =>
            Promise.resolve({
              ...snapshot,
              coreState: {
                ...snapshot.coreState,
                resources: actor ? resources : resources.filter((resource) => resource.type !== 1),
              },
            }),
          selectProject: () => Promise.resolve(snapshot),
          startRuntime: () => Promise.resolve(snapshot),
          stopRuntime: () => {
            controls.stop += 1;
            return Promise.resolve({
              ok: true,
              errors: [],
              snapshot: { ...snapshot, phase: 'stopped', pid: null },
            });
          },
          invokeCommand: () => Promise.reject(new Error('Use message actions in this test.')),
          dispatchAction: (request: NavigationRequest) => {
            requests.push(request);
            return Promise.resolve({
              ...request,
              ok: true,
              command: 'message',
              interactionId: null,
              durationMs: 1,
              response: null,
              error: null,
            });
          },
          onRuntimeState: () => () => {},
          controlWindow: (action: string) => {
            controls.window.push(action);
            return Promise.resolve(true);
          },
        },
      });
    });
    await page.goto('/');
    await expect(page.getByRole('main', { name: 'Virtual channel first' })).toBeVisible();

    const expectControlsInsideWindow = async () => {
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('Expected a fixed test viewport.');
      await expect(page.locator('.start-button')).toBeVisible();
      await expect(page.locator('.stop-button')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close window', exact: true })).toBeVisible();
      for (const control of [
        page.locator('.start-button'),
        page.locator('.stop-button'),
        page.getByRole('button', { name: 'Minimize window', exact: true }),
        page.getByRole('button', { name: 'Maximize window', exact: true }),
        page.getByRole('button', { name: 'Close window', exact: true }),
      ]) {
        if (!(await control.isVisible())) continue;
        const bounds = await control.boundingBox();
        if (bounds === null) throw new Error('Expected visible control bounds.');
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      }
    };
    await expectControlsInsideWindow();

    const picker = page.getByRole('combobox', { name: 'Conversation', exact: true });
    const sidebar = page.getByRole('complementary', { name: 'Virtual servers and channels' });
    if (width <= 1080) {
      await expect(sidebar).toBeHidden();
      await expect(picker).toBeVisible({ timeout: 2000 });
      await picker.focus();
      if (process.platform === 'darwin') {
        // macOS headless-shell suppresses native popups; typeahead still uses real keys.
        await picker.press('s');
      } else {
        await picker.press('Space');
        await picker.press('ArrowDown');
        await picker.press('Enter');
      }
      await picker.press('Tab');
      await expect(picker).not.toBeFocused();
      await expect(page.getByRole('main', { name: 'Virtual channel second' })).toBeVisible();
    } else {
      await expect(sidebar).toBeVisible();
      await expect(picker).toBeHidden();
    }
    const choose = async (guildName: string, channelId: string) => {
      if (await picker.isVisible()) {
        const option = picker.locator(`option[data-channel-id="${channelId}"]`);
        const value = await option.getAttribute('value');
        if (value === null) throw new Error('Conversation option must have a value.');
        await picker.selectOption(value);
      } else {
        const other = sidebar.locator('.other-server-row').filter({ hasText: guildName });
        if (await other.count()) await other.click();
        await sidebar.locator(`.channel-row[data-channel-id="${channelId}"]`).click();
      }
    };
    await choose('Other Lab', '2200');
    await expect(page.getByRole('main', { name: 'Virtual channel other' })).toBeVisible();
    await choose('Navigation Lab', '2100');
    await expect(page.getByRole('main', { name: 'Virtual channel second' })).toBeVisible();
    await page.getByRole('button', { name: 'Guild Editor', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Guild Editor', exact: true })).toBeVisible();
    await choose('Direct messages', '9000');
    await expect(page.getByRole('main', { name: 'Virtual channel 9000' })).toBeVisible();
    await expectControlsInsideWindow();
    await page.locator('.composer input').fill('Hello direct');
    await page.locator('.composer input').press('Enter');
    await expect.poll(() => page.evaluate(() => window.navigationRequests?.length ?? 0)).toBe(1);
    const direct = await page.evaluate(() => window.navigationRequests?.[0]);
    if (!direct) throw new Error('Expected the direct message action.');
    expect(direct.context).toEqual({ actorId: '3000', channelId: '9000' });
    expect(Object.hasOwn(direct.context, 'guildId')).toBe(false);
    expect(direct.action).toEqual({ type: 'message', content: 'Hello direct' });

    await page.setViewportSize({ width: width === 720 ? 1280 : 720, height: 720 });
    await expect(page.getByRole('main', { name: 'Virtual channel 9000' })).toBeVisible();
    if (width === 720)
      await expect(sidebar.locator('.channel-row.active')).toHaveAttribute(
        'data-channel-id',
        '9000',
      );
    else await expect(picker.locator('option:checked')).toHaveAttribute('data-channel-id', '9000');
    await page.setViewportSize({ width, height: 720 });
    await page.screenshot({ path: info.outputPath('direct-message-navigation.png') });

    await choose('Navigation Lab', '2000');
    await expect(page.getByRole('main', { name: 'Virtual channel first' })).toBeVisible();
    await page.locator('.composer input').fill('Hello guild');
    await page.locator('.composer input').press('Enter');
    await expect.poll(() => page.evaluate(() => window.navigationRequests?.length ?? 0)).toBe(2);
    const guild = await page.evaluate(() => window.navigationRequests?.[1]);
    if (!guild) throw new Error('Expected the guild message action.');
    expect(guild.context).toEqual({ actorId: '3000', guildId: '1000', channelId: '2000' });

    await page.getByRole('button', { name: 'Stop bot', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.navigationControls?.stop)).toBe(1);
    await page.getByRole('button', { name: 'Close window', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.navigationControls?.window))
      .toEqual(['close']);
  });
}
