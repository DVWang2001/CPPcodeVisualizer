/** The owner must review every changed lesson snapshot before it becomes a version. */
import { test, expect, Page } from "@playwright/test";
import { ensureLoggedIn } from "./helpers";

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

test("owner reviews, cancels, then confirms a title and annotation revision", async ({
  page
}) => {
  await ensureLoggedIn(page);
  const token = await csrfToken(page);
  const stamp = Date.now();
  const titleV1 = `版本一 ${stamp}`;
  const titleV2 = `版本二 ${stamp}`;
  const titleV3 = `版本三 ${stamp}`;
  const sourceV1 = "// v1\n//@guide: first\nint main() { return 0; }\n";
  const sourceV2 = "// v2\n//@guide: revised\nint main() { return 1; }\n";
  const sourceV3 = "// v3 branch\n//@guide: restored then branched\nint main() { return 3; }\n";

  const created = await page.request.post("/api/lessons", {
    headers: { "x-csrftoken": token, "Content-Type": "application/json" },
    data: {
      title: titleV1,
      bundle: {
        version: "2.0",
        fullname_to_render: "main.cpp",
        source_code: sourceV1,
        breakpoints: [],
        program_input: ""
      }
    }
  });
  expect(created.status()).toBe(201);
  const lessonId = (await created.json()).id;

  try {
    await page.goto(`/edit?lesson=${lessonId}`);
    await page.waitForFunction(
      () => (window as any).monaco?.editor?.getModels()?.length > 0
    );
    await page.waitForFunction(
      source => (window as any).monaco.editor.getModels()[0]?.getValue() === source,
      sourceV1
    );

    const ownerPut = page
      .waitForRequest(
        request =>
          request.method() === "PUT" &&
          request.url().endsWith(`/api/lessons/${lessonId}`),
        { timeout: 500 }
      )
      .then(() => true)
      .catch(() => false);
    page.once("dialog", dialog => dialog.accept(titleV1));
    await page.getByTestId("save-lesson-to-account").click();
    expect(await ownerPut).toBe(false);
    await expect(page.getByTestId("lesson-commit-dialog")).toHaveCount(0);
    const unchanged = await page.request.get(`/api/lessons/${lessonId}`);
    expect(await unchanged.json()).toMatchObject({
      title: titleV1,
      current_version: 1,
      bundle: { source_code: sourceV1 }
    });

    const editorInput = page.locator(".monaco-editor textarea.inputarea").first();
    await editorInput.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(sourceV2);
    await page.waitForFunction(
      source => (window as any).monaco.editor.getModels()[0]?.getValue() === source,
      sourceV2
    );

    page.once("dialog", dialog => dialog.accept(titleV2));
    await page.getByTestId("save-lesson-to-account").click();
    await expect(page.getByTestId("lesson-commit-dialog")).toBeVisible();
    await page.getByTestId("lesson-commit-cancel").click();

    const cancelled = await page.request.get(`/api/lessons/${lessonId}`);
    expect(cancelled.status()).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      title: titleV1,
      current_version: 1,
      bundle: { source_code: sourceV1 }
    });

    page.once("dialog", dialog => dialog.accept(titleV2));
    await page.getByTestId("save-lesson-to-account").click();
    await page.getByTestId("lesson-commit-confirm").click();

    await expect
      .poll(async () => {
        const current = await page.request.get(`/api/lessons/${lessonId}`);
        return current.json();
      })
      .toMatchObject({
        title: titleV2,
        current_version: 2,
        bundle: { source_code: sourceV2 }
      });

    await page.getByTestId("lesson-history-open").click();
    await expect(page.getByTestId("lesson-history-dialog")).toBeVisible();
    await expect(page.getByTestId("lesson-version-node-1")).toBeVisible();
    await expect(page.getByTestId("lesson-version-node-2")).toBeVisible();
    await expect(page.getByText("HEAD", { exact: true })).toBeVisible();

    await page.getByTestId("lesson-version-node-1").click();
    await expect(page.getByText(titleV1, { exact: true })).toBeVisible();
    await page.getByTestId("lesson-version-restore").click();
    await expect(page.getByTestId("lesson-history-dialog")).toHaveCount(0);
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).monaco.editor.getModels()[0]?.getValue())))
      .toBe(sourceV1);

    const restoredWithoutSaving = await page.request.get(`/api/lessons/${lessonId}/versions`);
    expect(await restoredWithoutSaving.json()).toMatchObject({ current_version: 2 });

    await page.evaluate(source => {
      (window as any).monaco.editor.getModels()[0].setValue(source);
    }, sourceV3);
    page.once("dialog", dialog => {
      expect(dialog.defaultValue()).toBe(titleV1);
      dialog.accept(titleV3);
    });
    await page.getByTestId("save-lesson-to-account").click();
    await expect(page.getByTestId("lesson-commit-dialog")).toBeVisible();
    await page.getByTestId("lesson-commit-confirm").click();

    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/lessons/${lessonId}/versions`);
        return response.json();
      })
      .toMatchObject({
        current_version: 3,
        versions: expect.arrayContaining([
          { version: 3, parent_version: 1, title: titleV3 },
          { version: 2, parent_version: 1, title: titleV2 },
          { version: 1, parent_version: null, title: titleV1 }
        ])
      });
  } finally {
    await page.request.delete(`/api/lessons/${lessonId}`, {
      headers: { "x-csrftoken": token }
    });
  }
});
