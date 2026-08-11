import { completeOnboarding, expect, navigate, test } from './fixtures';

test.describe('Main content scrolling', () => {
  test('a long page scrolls vertically with the wheel instead of overflowing the window', async ({
    page,
  }) => {
    await completeOnboarding(page);
    await navigate(page, 'Investors');
    await page.waitForTimeout(1500);

    const viewportHeight = await page.evaluate(() => window.innerHeight);

    // The shell must stay pinned to the window. Regression guard for the
    // app-shell grid row being auto-sized, which let #main-content grow to the
    // full content height (~18000px) so it never became a scroll container and
    // vertical wheel scrolling did nothing.
    const layout = await page.evaluate(() => {
      const main = document.getElementById('main-content')!;
      const shell = document.querySelector('.app-shell') as HTMLElement;
      return {
        shellHeight: shell.offsetHeight,
        mainHeight: main.offsetHeight,
        clientHeight: main.clientHeight,
        scrollHeight: main.scrollHeight,
      };
    });

    expect(layout.shellHeight).toBeLessThanOrEqual(viewportHeight);
    expect(
      layout.mainHeight,
      'main-content must stay within the window rather than growing to fit its content',
    ).toBeLessThanOrEqual(viewportHeight);
    expect(
      layout.scrollHeight,
      'the Investors page should have more content than fits on screen',
    ).toBeGreaterThan(layout.clientHeight);

    const rect = await page.evaluate(() => {
      const r = document.getElementById('main-content')!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(1200); // scroll-behavior: smooth needs settling time

    const scrollTop = await page.evaluate(() => document.getElementById('main-content')!.scrollTop);
    expect(scrollTop, 'a vertical wheel gesture must scroll the main content').toBeGreaterThan(0);
  });
});
