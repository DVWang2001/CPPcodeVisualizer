import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * A real logged-in browser, with a live debug session, cannot read the server's
 * secrets through /read_file or /get_last_modified_unix_sec.
 *
 * The in-container pytest suite makes the same claim against the Flask app
 * object.  This spec makes it against the running deployment: real WSGI server,
 * real session cookie, real CSRF token, real jail -- i.e. exactly what an
 * attacker has.  Registration is open, so "logged in" is not a barrier; the
 * account below is one anybody could create.
 *
 * The two targets matter for different reasons:
 *
 *   /var/lib/gdbgui/secret_key   signs the session cookie.  Reading it forges
 *                               any user's session, hence any owner_key(),
 *                               hence any jail -- it is game over, not a leak.
 *   /var/lib/gdbgui/gdbgui.sqlite3   every account's password hash.
 *
 * Both are -rw------- root, and the fix makes the routes touch the filesystem
 * as the caller's own session account instead of as root.
 *
 * A live jail is a precondition, not a detail: with no jail the routes refuse
 * everything, so probing without one would prove nothing about confinement.
 * Hence the compile-and-run before the probes.
 */

const TINY_PROGRAM = `int main() {
    int x = 41;
    return x + 1;
}
`;

const TARGETS = [
    '/var/lib/gdbgui/secret_key',
    '/var/lib/gdbgui/gdbgui.sqlite3',
    '/etc/shadow',
];

test('a logged-in user cannot read server secrets through the file routes', async ({ page }) => {
    test.setTimeout(180_000);
    await ensureLoggedIn(page);
    await page.goto('/');

    await page.waitForFunction(() => (window as any).store !== undefined, null, {
        timeout: 15_000,
    });

    await page.evaluate((src) => {
        (window as any).gdbgui_get_editor_value = () => src;
    }, TINY_PROGRAM);
    await page.click('#run_button');

    // A live jail is the precondition.  Stopping in the debugger proves the
    // session has one -- gdb itself runs as the session's OS account.
    await page.waitForFunction(
        () => (window as any).store.get('inferior_program') === 'paused',
        null,
        { timeout: 90_000 }
    );

    // Control: with that same jail, the user's own source IS readable.  Without
    // this, "everything is refused" would pass the test below and the routes
    // could be broken outright rather than confined.
    await page.waitForFunction(
        () =>
            ((window as any).store.get('cached_source_files') || []).some(
                (f: any) => f.fullname === '/workspace/main.cpp'
            ),
        null,
        { timeout: 20_000 }
    );

    const results = await page.evaluate(async (targets: string[]) => {
        const csrf = (window as any).initial_data.csrf_token;
        const out: any[] = [];
        for (const path of targets) {
            for (const route of ['/read_file', '/get_last_modified_unix_sec']) {
                const qs =
                    route === '/read_file'
                        ? `?path=${encodeURIComponent(path)}&start_line=1&end_line=200&highlight=false`
                        : `?path=${encodeURIComponent(path)}`;
                const response = await fetch(route + qs, {
                    headers: { 'x-csrftoken': csrf },
                });
                out.push({
                    route,
                    path,
                    status: response.status,
                    body: (await response.text()).slice(0, 400),
                });
            }
        }
        return out;
    }, TARGETS);

    for (const r of results) {
        console.log(`[e2e] ${r.route} ${r.path} -> ${r.status} ${r.body}`);
        expect(r.status, `${r.route} ${r.path} was not refused`).toBe(400);
        expect(JSON.parse(r.body)).toEqual({
            message: 'File not found or not accessible',
        });
    }

    // And the same request for a path that does not exist is byte-identical, so
    // neither route is left as an existence oracle in a different shape.
    const oracle = await page.evaluate(async () => {
        const csrf = (window as any).initial_data.csrf_token;
        const ask = async (route: string, path: string) => {
            const qs =
                route === '/read_file'
                    ? `?path=${encodeURIComponent(path)}&start_line=1&end_line=5&highlight=false`
                    : `?path=${encodeURIComponent(path)}`;
            const response = await fetch(route + qs, { headers: { 'x-csrftoken': csrf } });
            return { status: response.status, body: await response.text() };
        };
        const out: any = {};
        for (const route of ['/read_file', '/get_last_modified_unix_sec']) {
            out[route] = {
                real: await ask(route, '/var/lib/gdbgui/secret_key'),
                missing: await ask(route, '/var/lib/gdbgui/no-such-file-at-all'),
            };
        }
        return out;
    });

    for (const route of ['/read_file', '/get_last_modified_unix_sec']) {
        console.log(
            `[e2e] ${route} forbidden=${JSON.stringify(oracle[route].real)} missing=${JSON.stringify(oracle[route].missing)}`
        );
        expect(oracle[route].real.status).toBe(oracle[route].missing.status);
        expect(oracle[route].real.body).toBe(oracle[route].missing.body);
    }
});
