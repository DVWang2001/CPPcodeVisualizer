/**
 * 即時課堂（薄中繼）e2e 共用的小工具：登入並建教案、解 QR 像素、手機加入、
 * 觀察 WebSocket 框架。不是 spec（檔名不符 *.spec.ts），playwright 不會單獨執行它。
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { expect, Locator, Page } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

export const SOURCE = readFileSync(
  path.resolve(__dirname, '../../examples/cpp/e2e_containers.cpp'),
  'utf8'
);
const JSQR_SOURCE = readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8');

/**
 * 第一次按 Run 要在瀏覽器裡載入並執行 clang.wasm 編譯，慢的時候超過 playwright 預設的
 * 10 秒 actionTimeout。base commit 上這兩支 spec 失敗的主因之一就是這個，所以所有
 * 「要等 Run 的結果」的等待都用這個上限。
 */
export const COMPILE_TIMEOUT = 120_000;

export async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

export const choiceQuestion = (id = 'q1') => ({
  id,
  prompt: 'i 是多少？',
  options: [
    { id: 'zero', text: '0' },
    { id: 'one', text: '1' },
  ],
  correct_option_id: 'one',
  explanation: '程式已執行到指定行。',
  trigger: {
    kind: 'source_line',
    source_file: 'e2e_containers.cpp',
    line: 26,
    anchor: {
      line_text: 'volatile int x = 0; (void)x;',
      before_text: ') {',
      after_text: '}',
    },
  },
});

export const tableQuestion = () => ({
  id: 'dp-table',
  kind: 'table',
  prompt: '填出 dp 的內容',
  explanation: '兩列兩欄的動態規劃表。',
  table_spec: { var_hint: 'dp', max_cells: 4 },
  trigger: choiceQuestion().trigger,
});

/** 登入、建一份帶題目的教案、打開它並等到「即時課堂」勾選框出現。 */
export async function loginAndOpenQuizLesson(
  page: Page,
  title: string,
  questions: any[]
): Promise<number> {
  await setupPage(page);
  await page.addInitScript(() => localStorage.setItem('show_tour_guide', 'false'));
  await ensureLoggedIn(page);
  await page.goto('/edit');
  const created = await page.request.post('/api/lessons', {
    headers: {
      'Content-Type': 'application/json',
      'x-csrftoken': await csrfToken(page),
    },
    data: {
      title,
      bundle: {
        version: '2.0',
        fullname_to_render: 'e2e_containers.cpp',
        source_code: SOURCE,
        breakpoints: [{ line: '26', enabled: 'y', is_normal_breakpoint: true }],
        program_input: '',
        quiz: { schema_version: 1, questions },
      },
    },
  });
  expect(created.status()).toBe(201);
  const lessonId = (await created.json()).id;
  await page.goto(`/edit?lesson=${lessonId}`);
  await expect(page.getByTestId('live-quiz-open')).toBeVisible({ timeout: 15_000 });
  return lessonId;
}

export async function decodeQrPixels(qr: Locator): Promise<string> {
  await qr.waitFor({ state: 'visible' });
  await expect.poll(
    () => qr.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    { timeout: 10_000 }
  ).toBe(true);
  // Monaco exposes an AMD loader; hide it only inside this wrapper so jsQR installs on window.
  await qr.page().addScriptTag({
    content: `{ const define = undefined, exports = undefined, module = undefined; ${JSQR_SOURCE} }`,
  });
  return qr.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = (window as any).jsQR(pixels.data, pixels.width, pixels.height);
    if (!result) throw new Error('Rendered QR pixels could not be decoded');
    return result.data;
  });
}

export type StartedClass = { sessionId: number; joinUrl: string };

/**
 * 按 Run：開一堂新課堂（POST /api/live-quiz/sessions）並跳出全螢幕 QR，程式要等老師
 * 把 QR 關掉才真的開始跑（gateRun）。這裡不關 QR——學生要趁它還開著掃。
 * 老師不再把場次編號放進 sessionStorage（課堂只活在分頁記憶體裡），所以編號從建立回應取。
 */
export async function runAndDecodeQr(page: Page): Promise<StartedClass> {
  // 瀏覽器引擎的編譯有 8 秒牆鐘預算（static/engine/index.js 的 compileTimeoutMs）；
  // 測試機 CPU 一忙（前一個測試的瀏覽器剛收掉、clang.wasm 冷啟動）就會超時，
  // 畫面上是「Compilation failed」而不是課堂開不起來。這是引擎的已知特性，不是
  // 即時課堂的缺陷，所以編譯失敗時重按 Run（最多 3 次）；其他任何失敗照常讓測試失敗。
  let response = null;
  for (let attempt = 1; attempt <= 3 && response === null; attempt += 1) {
    const created = page.waitForResponse(
      r =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/live-quiz/sessions',
      { timeout: COMPILE_TIMEOUT }
    ).catch(() => null);
    const compileFailed = page.waitForEvent('console', {
      predicate: message => message.text().includes('Compilation failed'),
      timeout: COMPILE_TIMEOUT,
    }).then(() => 'compile-failed' as const, () => null);
    await page.click('#run_button');
    const outcome = await Promise.race([created, compileFailed]);
    if (outcome === 'compile-failed') {
      console.log(`[e2e] compile timed out on attempt ${attempt}; pressing Run again`);
      continue;
    }
    response = await created;
  }
  if (response === null) throw new Error('POST /api/live-quiz/sessions never happened after 3 Run attempts');
  expect(response.status()).toBe(201);
  const sessionId = (await response.json()).id as number;
  const dialog = page.getByRole('dialog', { name: '放大的加入 QR Code' });
  await expect(dialog).toBeVisible({ timeout: COMPILE_TIMEOUT });
  const joinUrl = await decodeQrPixels(dialog.locator("img[alt='學生加入課堂的 QR Code']"));
  expect(new URL(joinUrl).pathname).toMatch(/^\/join\/[^/]+$/);
  return { sessionId, joinUrl };
}

/** 學生都掃完了：關掉 QR 放行，程式從頭編譯並跑到綁定行（第 26 行）停下。 */
export async function releaseToBoundLine(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: '放大的加入 QR Code' })
    .getByRole('button', { name: '關閉' }).click();
  await page.waitForFunction(
    () => Number((window as any).store?.get('paused_on_frame')?.line) === 26,
    null,
    { timeout: COMPILE_TIMEOUT }
  );
}

export async function joinStudent(page: Page, url: string, nickname: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel('顯示暱稱').fill(nickname);
  await page.getByRole('button', { name: '加入課堂' }).click();
  await expect(page.getByText('已加入，請等待老師播放到題目。')).toBeVisible();
}

/** 學生端的兩步送出：選好之後按「送出答案」，再按確認列的「確認送出」。 */
export async function confirmSubmit(page: Page, buttonName: '送出答案' | '更新答案'): Promise<void> {
  await page.getByRole('button', { name: buttonName }).click();
  await page.getByRole('button', { name: '確認送出' }).click();
}

/**
 * 蒐集這個 page 從 /socket.io/ 收到的所有內容。伺服器關掉了 transport 升級
 * （server.py 的 allow_upgrades=False），實際走的是長輪詢，所以要讀輪詢回應的內文；
 * 也順便收 WebSocket 框架，萬一哪天開了升級這裡不會悄悄變成空的。要在 goto 之前呼叫。
 * 內文是非同步讀進來的：要「出現某段文字」請用 expect.poll，不要立刻 expect。
 */
export function recordReceivedFrames(page: Page): string[] {
  const frames: string[] = [];
  // 伺服器的 JSON 把中文編成反斜線加 u 加四位十六進位（巢狀的還會多一層反斜線）；
  // 先還原再收，否則「不含解說文字」這類斷言會因為字串根本對不上而永遠通過。
  const decode = (text: string) =>
    text.replace(/\\+u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  page.on('websocket', ws => {
    ws.on('framereceived', frame => frames.push(decode(String(frame.payload))));
  });
  page.on('response', response => {
    if (!response.url().includes('/socket.io/') || response.request().method() !== 'GET') return;
    response.text().then(text => { frames.push(decode(text)); }, () => undefined);
  });
  return frames;
}

/**
 * 在學生頁面攔下送出的 student:answer（長輪詢的 POST 內文），讓測試能把同一份答案
 * 原封不動再送一次，模擬「5 秒收不到老師回覆」的自動重送。要在 goto 之前呼叫。
 */
export async function installAnswerResender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    const proto = XMLHttpRequest.prototype as any;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const marker = '42/lesson_quiz,["student:answer"';
    w.__answerPosts = 0;
    w.__lastAnswer = null;
    proto.open = function (method: string, url: string) {
      this.__e2e = { method, url };
      return nativeOpen.apply(this, arguments);
    };
    proto.send = function (body: any) {
      if (this.__e2e && this.__e2e.method === 'POST' && typeof body === 'string') {
        const packet = body.split('').find(part => part.indexOf(marker) === 0);
        if (packet) {
          w.__answerPosts += 1;
          w.__lastAnswer = { url: this.__e2e.url, packet };
        }
      }
      return nativeSend.apply(this, arguments);
    };
    w.__resendLastAnswer = (newNonce: string | null) => {
      const last = w.__lastAnswer;
      if (!last) throw new Error('no student:answer packet was captured');
      const body = JSON.parse(last.packet.slice(last.packet.indexOf(',') + 1));
      if (newNonce) body[1].nonce = newNonce;
      const request = new XMLHttpRequest();
      nativeOpen.call(request, 'POST', last.url);
      request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      nativeSend.call(request, '42/lesson_quiz,' + JSON.stringify(body));
    };
  });
}

/** 老師全螢幕題目畫面裡，某個選項目前的人數。 */
export async function optionCount(page: Page, optionText: string): Promise<number | null> {
  return page.getByTestId('live-quiz-active-overlay').evaluate((overlay, text) => {
    for (const span of Array.from(overlay.querySelectorAll('span'))) {
      const label = (span.textContent || '').replace(/^✓\s*/, '').trim();
      const next = span.nextElementSibling;
      if (label === text && next && /^\d+$/.test((next.textContent || '').trim())) {
        return Number((next.textContent || '').trim());
      }
    }
    return null;
  }, optionText);
}

export async function deleteLesson(
  request: { delete: (url: string, options: any) => Promise<any> },
  lessonId: number | null,
  csrf: string
): Promise<void> {
  if (lessonId === null) return;
  await request.delete(`/api/lessons/${lessonId}`, { headers: { 'x-csrftoken': csrf } });
}

/**
 * 讓老師頁面能「立刻」斷掉 /lesson_quiz：用它自己的長輪詢 sid 送一個 Socket.IO 的
 * namespace DISCONNECT 封包（41/lesson_quiz,）。伺服器只開長輪詢，直接關分頁要等
 * Engine.IO 的 ping 逾時（約 45 秒）才偵測得到；這個做法讓寬限期的起點是已知的時間點，
 * 才能驗「寬限期內仍在、寬限期後結束」。要在 goto 之前呼叫。
 */
export async function installTeacherSocketDropper(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    const proto = XMLHttpRequest.prototype as any;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    proto.open = function (method: string, url: string) {
      this.__e2e = { method, url };
      return nativeOpen.apply(this, arguments);
    };
    proto.send = function (body: any) {
      if (this.__e2e && this.__e2e.method === 'POST' && String(this.__e2e.url).includes('/socket.io/') &&
          typeof body === 'string' && body.indexOf('42/lesson_quiz,') >= 0) {
        w.__teacherPollUrl = this.__e2e.url;
      }
      return nativeSend.apply(this, arguments);
    };
    w.__dropTeacherSocket = () => {
      if (!w.__teacherPollUrl) throw new Error('no teacher socket.io POST seen yet');
      const request = new XMLHttpRequest();
      nativeOpen.call(request, 'POST', w.__teacherPollUrl);
      request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      nativeSend.call(request, '41/lesson_quiz,');
    };
  });
}
