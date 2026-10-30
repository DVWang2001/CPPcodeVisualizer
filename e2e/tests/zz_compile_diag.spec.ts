import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * 編譯錯誤視覺化（第一期）接入 CompileErrors 面板：
 * 編譯失敗後，每個 error 顯示一個視覺化畫面，原文列表仍保留在下方。
 *
 * 樣本：型別不符（init-type），clang 訊息為 "cannot initialize a variable of type 'int'
 * with an lvalue of type 'const char[3]'"，見 tests/compile-diag/family2/init-type.cpp。
 */
const SOURCE = `int main() {
  int x = "hi";
  return x;
}
`;

const BUNDLE = {
    version: '2.0',
    fullname_to_render: '',
    source_code: SOURCE,
    breakpoints: [],
    program_input: '',
};

async function compileAndExpect(page: any, source: string, kind: string, title: string, raw: string) {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 20_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 20_000 });

    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: `compile-diag-${kind}.gdbgui.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ ...BUNDLE, source_code: source })),
    });
    await page.waitForTimeout(2000);

    await page.click('#run_button');

    const view = page.locator(`[data-testid="compile-diag-view"][data-kind="${kind}"]`);
    await expect(view).toBeVisible({ timeout: 60_000 });
    await expect(view).toContainText(title);
    await expect(view).toContainText(raw);

    // 原文列表仍在（視覺化是加在它上方，不是取代它）
    await expect(page.locator('.compile-error-row').first()).toBeVisible();
}

test('家族 2 型別：初始化型別不符，視覺化出現、原文保留', async ({ page }) => {
    await compileAndExpect(page, SOURCE, 'init-type', '初始化型別不符', "cannot initialize a variable of type 'int'");
});

test('家族 1 名稱與作用域：未宣告的名稱，視覺化出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'int main() {\n  for (int i = 0; i < 3; i++) { cnt += i; }\n}\n',
        'undeclared',
        '未宣告的名稱',
        "use of undeclared identifier 'cnt'",
    );
});

test('家族 3 語法：缺少分號，視覺化出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'int main() {\n  int a = 5\n  int b = 7;\n  return a + b;\n}\n',
        'missing-semicolon',
        '缺少分號',
        "expected ';' at end of declaration",
    );
});

test('家族 4 函式呼叫：參數不符，視覺化與候選清單出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'void add(int a, int b) { }\nint main() {\n  add(1);\n  return 0;\n}\n',
        'no-matching-call',
        '參數不符',
        "no matching function for call to 'add'",
    );
    await expect(page.locator('[data-testid="candidate-list"]').first()).toBeVisible();
});

test('家族 5 模板：標頭內的實例化錯誤，以使用者程式的錨點呈現', async ({ page }) => {
    await compileAndExpect(
        page,
        '#include <algorithm>\n#include <vector>\nstruct Card { int id; };\nint main() {\n  std::vector<Card> cards{Card{1}, Card{2}};\n  std::sort(cards.begin(), cards.end());\n  return 0;\n}\n',
        'template-operator',
        '模板實例化失敗',
        "invalid operands to binary expression ('const Card' and 'const Card')",
    );
});

test('家族 7 類別與繼承：抽象類別，視覺化出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'struct Shape {\n  virtual double area() = 0;\n};\nint main() {\n  Shape s;\n  return 0;\n}\n',
        'abstract-class',
        '抽象類別',
        "variable type 'Shape' is an abstract class",
    );
});

test('家族 8 流程與回傳：lambda 捕捉，視覺化出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'int main() {\n  int n = 1;\n  auto f = []() { return n; };\n  return f();\n}\n',
        'lambda-capture',
        'lambda 捕捉',
        "variable 'n' cannot be implicitly captured in a lambda with no capture-default specified",
    );
});

test('家族 6 const：修改常數，視覺化出現', async ({ page }) => {
    await compileAndExpect(
        page,
        'int main() {\n  const int N = 3;\n  N = 4;\n  return N;\n}\n',
        'const-assign',
        '修改常數',
        "cannot assign to variable 'N' with const-qualified type 'const int'",
    );
});
