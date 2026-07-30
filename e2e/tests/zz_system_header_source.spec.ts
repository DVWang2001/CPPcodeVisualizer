import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * Stepping into a system header still shows its source.
 *
 * This is the behaviour that /read_file's confinement fix must not break, and
 * the reason the fix is "read as the calling session's own OS account" rather
 * than a path allowlist.  Every file the debugger can stop in has to remain
 * readable, and libstdc++ headers move between compiler versions
 * (/usr/include/c++/14/... today), so an allowlist would need maintaining;
 * file permissions already say "world-readable, go ahead".
 *
 * It has to be exercised through the app rather than by calling /read_file
 * directly: the path here is chosen by GDB (the stop frame's `fullname`), not
 * by the test, and it travels through FileOps' cache and the virtual->real
 * translation before it ever reaches the route.
 *
 * What is checked is FileOps' cache and source_code_state, not the Monaco
 * buffer.  That is not a weaker assertion, it is the right one: this fork's
 * SourceCode.render() always prefers the live editor content once Monaco is
 * mounted (SourceCode.tsx: "Monaco is already mounted -- always prefer the live
 * editor content"), so the buffer keeps showing whatever the user was editing
 * regardless of what the server returned.  The cache is filled ONLY by a 200
 * from /read_file carrying a source_code_array, and everything the app later
 * displays for that file comes out of it -- so a refusal shows up here as a
 * missing entry plus source_code_state FILE_MISSING.
 */

// Header-defined templates get debug info from the user's own -g compilation,
// so a single `step` from the vector operations lands inside libstdc++'s
// headers.  Nothing here touches the filesystem or the network.
const VECTOR_PROGRAM = `#include <vector>

int main() {
    std::vector<int> v;
    v.push_back(1);
    v.push_back(2);
    return v[0] + v[1];
}
`;

test('stepping into a system header still displays its source', async ({ page }) => {
    test.setTimeout(180_000);
    await ensureLoggedIn(page);
    await page.goto('/');

    await page.waitForFunction(() => (window as any).store !== undefined, null, {
        timeout: 15_000,
    });

    // Feeding the compiler means overriding the very getter we later use to read
    // what is DISPLAYED, so keep the real one and put it back once the run has
    // started.  (Without this the test reads its own fixture back and passes no
    // matter what the server returned -- it did, the first time it was run.)
    await page.evaluate((src) => {
        (window as any).__real_get_editor_value = (window as any).gdbgui_get_editor_value;
        (window as any).gdbgui_get_editor_value = () => src;
    }, VECTOR_PROGRAM);

    await page.click('#run_button');

    // Stop at main first.  Without this the step loop below could run before
    // gdb has a frame at all and "never reached a header" would be ambiguous.
    await page.waitForFunction(
        () => (window as any).store.get('inferior_program') === 'paused',
        null,
        { timeout: 90_000 }
    );

    await page.evaluate(() => {
        (window as any).gdbgui_get_editor_value = (window as any).__real_get_editor_value;
    });

    const ownFilename = await page.evaluate(() =>
        (window as any).gdbgui_get_editor_filename?.()
    );
    console.log(`[e2e] stopped in: ${ownFilename}`);

    // The other half of the claim: the user's OWN source still comes back, and
    // it does so through the virtual /workspace path -- so the server's
    // virtual->real translation still resolves under the new model.  Read from
    // FileOps' cache rather than the editor: the editor holds the buffer the
    // user is editing, while the cache is filled ONLY by a 200 from /read_file.
    expect(ownFilename).toBe('/workspace/main.cpp');
    // The fetch is asynchronous with the stop, so wait for it rather than
    // sampling once (sampling flakes, and a flaky containment test is useless).
    await page.waitForFunction(
        () =>
            ((window as any).store.get('cached_source_files') || []).some(
                (f: any) => f.fullname === '/workspace/main.cpp'
            ),
        null,
        { timeout: 20_000 }
    );
    const ownCached = await page.evaluate(() =>
        ((window as any).store.get('cached_source_files') || []).find(
            (f: any) => f.fullname === '/workspace/main.cpp'
        )
    );
    expect(ownCached, '/workspace/main.cpp was never fetched').toBeTruthy();
    // Strip the syntax-highlighting markup the server applies before matching.
    const ownText = Object.values(ownCached.source_code_obj)
        .join('\n')
        .replace(/<[^>]*>/g, '');
    expect(ownText).toContain('push_back');

    // Step until gdb puts us inside a system header.  A bounded loop, not a
    // fixed number of steps: how many `step`s it takes to leave main depends on
    // the libstdc++ version's inlining.
    let headerFile: string | undefined;
    for (let i = 0; i < 25 && !headerFile; i++) {
        await page.evaluate(() => (window as any).gdbgui_run_autoplay_command('step-in'));
        await page.waitForTimeout(700);
        const fullname = await page.evaluate(() =>
            (window as any).store.get('fullname_to_render')
        );
        if (typeof fullname === 'string' && fullname.startsWith('/usr/')) {
            headerFile = fullname;
        }
    }

    console.log(`[e2e] stepped into: ${headerFile}`);
    expect(headerFile, 'gdb never stopped inside a system header').toBeTruthy();

    // The header's bytes must actually have come back.  FileOps only caches a
    // file after a 200 from /read_file carrying a source_code_array; a refusal
    // takes the error branch, which calls add_missing_file instead.
    await page.waitForFunction(
        (expected) =>
            ((window as any).store.get('cached_source_files') || []).some(
                (f: any) => f.fullname === expected
            ),
        headerFile,
        { timeout: 20_000 }
    );
    const cached = await page.evaluate(
        (expected) =>
            ((window as any).store.get('cached_source_files') || []).find(
                (f: any) => f.fullname === expected
            ),
        headerFile
    );
    expect(cached, 'the header was never cached, so /read_file never succeeded').toBeTruthy();
    expect(cached.exists).toBe(true);
    expect(cached.num_lines_in_file).toBeGreaterThan(50);
    expect(cached.last_modified_unix_sec).toBeGreaterThan(0);

    const headerText = Object.values(cached.source_code_obj)
        .join('\n')
        .replace(/<[^>]*>/g, '');
    console.log(`[e2e] header source cached: ${headerText.length} chars`);
    console.log(`[e2e] first line: ${headerText.split('\n')[0]}`);
    // Real C++ from a libstdc++ header, not a placeholder or an error string.
    expect(headerText).toMatch(/(namespace|template|_GLIBCXX|class|inline)/);
    expect(headerText).not.toContain('File not found');

    // And the app considers the file present, not missing.
    const state = await page.evaluate(() => (window as any).store.get('source_code_state'));
    console.log(`[e2e] source_code_state: ${state}`);
    expect(state).not.toBe('FILE_MISSING');
});
