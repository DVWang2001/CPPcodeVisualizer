import { execSync } from 'child_process';
import * as path from 'path';

/**
 * 開跑前確認：正在服務的容器，是不是從目前的工作區建出來的。
 *
 * 這個檢查存在的理由不是 Docker 快取有問題（實測是對的：改 .tsx 會重建
 * bundle），而是「我到底在測哪一版」先前沒有辦法一秒回答。一次改完程式碼
 * 忘記重建，整輪測試結果就是騙人的——而它看起來完全正常。
 *
 * 失敗時直接讓整批測試停下來，不要讓任何一條測試跑出可能是假的結果。
 *
 * 兩種跑法各有各的保證，別搞混：
 *
 *   1. 從宿主機跑（測 :5000 的開發容器）——這個檢查會生效。
 *   2. 在 docker-compose.test.yml 的 e2e 容器裡跑——容器內沒有 docker CLI，
 *      這個檢查拿不到指紋，會略過。那條路徑的保證來自**一律加 --build**：
 *
 *        docker compose -f docker-compose.test.yml run --rm --build e2e npx playwright test
 *
 *      沒改東西時 --build 幾乎不花時間（全部命中快取），所以沒有省略的理由。
 *
 * 刻意不把指紋做成 HTTP 端點：/static 在未登入白名單裡，那等於公開建置指紋。
 */
async function globalSetup() {
    const repo = path.join(__dirname, '..');
    const run = (cmd: string) =>
        execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    let local: string;
    let running: string;
    try {
        local = run('python scripts/source_stamp.py');
        running = run('docker compose exec -T gdbgui cat /app/.build-stamp')
            .split('\n').pop()!.trim();
    } catch (err: any) {
        console.warn(
            '[global-setup] 略過建置版本檢查（拿不到指紋，多半是在 e2e 容器裡跑）。\n' +
            '               這條路徑請一律用 --build，否則 app 可能是舊的：\n' +
            '               docker compose -f docker-compose.test.yml run --rm --build e2e ...\n' +
            '               原因：' + String(err?.message || err).split('\n')[0]
        );
        return;
    }

    if (local !== running) {
        throw new Error(
            '\n\n' +
            '  容器裡跑的不是你目前的程式碼。\n\n' +
            `    工作區：${local}\n` +
            `    容器裡：${running}\n\n` +
            '  先重建再測：docker compose up -d --build\n' +
            '  （測試已中止，避免產生看起來正常但其實無效的結果。）\n'
        );
    }
    console.log(`[global-setup] 建置版本相符：${local}`);
}

export default globalSetup;
