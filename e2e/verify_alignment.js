// Standalone visual check: injects guide data into a live gdbgui page and
// measures whether every step-column separator sits at the same x position.
// Run: node verify_alignment.js   (expects app at http://localhost:5000)
const { chromium } = require('@playwright/test');

const SOURCE = `#include <iostream>
using namespace std;

int main() {
    int n = 6;
    while (n != 1) {
        if (n % 2 == 0) {
            n = n / 2;
        } else {
            n = 3 * n + 1;
        }
    }
    return 0;
}`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') console.log('[browser error]', m.text()); });

  await page.goto('http://localhost:5000');
  await page.waitForFunction(() =>
    (window).gdbgui_global_variable !== undefined && (window).store !== undefined,
    null, { timeout: 15000 });

  await page.evaluate((src) => {
    const g = (window).gdbgui_global_variable;
    g.__source_text = src;
    g.__line = { 7: '{n} guide', 8: '{n} guide', 10: '{n} guide' };
    g.__guide = new Map([
      ['7', ['6', '3']],
      ['8', ['3']],
      ['10', [' ', '10']],
    ]);
    (window).store.set('inferior_program', 'paused');
  }, SOURCE);

  // Dismiss the welcome tour and expand the collapsed "visualizer" section
  await page.click('button:has-text("Dismiss")').catch(() => {});
  await page.click('text=visualizer').catch(() => {});

  // Visualizer re-renders on a 1s interval
  await page.waitForTimeout(2000);

  const result = await page.evaluate(() => {
    const seps = [];
    document.querySelectorAll('span').forEach((el) => {
      const bl = el.style.borderLeft || '';
      if (bl.includes('144, 202, 249') || bl.includes('90caf9')) {
        seps.push({ x: el.getBoundingClientRect().left, text: el.textContent });
      }
    });
    return seps;
  });

  console.log('separator cells found:', result.length);
  result.forEach(s => console.log(`  x=${s.x.toFixed(2)}  text="${s.text}"`));
  const xs = [...new Set(result.map(s => s.x.toFixed(1)))];
  console.log(xs.length === 1 && result.length > 0
    ? `ALIGNED ✓ (all separators at x=${xs[0]})`
    : `MISALIGNED ✗ (distinct x positions: ${xs.join(', ')})`);

  await page.screenshot({ path: 'alignment_check.png', fullPage: false });
  console.log('screenshot saved: alignment_check.png');
  await browser.close();
  process.exit(xs.length === 1 && result.length > 0 ? 0 : 1);
})();
