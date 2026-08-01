# Lesson Library Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the signed-in lesson library as a responsive, LeetCode-inspired workbench and add a persistent link to the logged-in user's existing profile.

**Architecture:** Keep the server-rendered Jinja pages and existing lesson-library query parameters unchanged. Add one application-wide template context value for the signed-in user, use it in the shared auth-page frame to render the top navigation, then change only the lesson-library markup and CSS from a narrow list to a responsive table-like workbench.

**Tech Stack:** Flask/Jinja, existing Python/pytest suite, CSS media queries, Playwright.

## Global Constraints

- Do not add a database column, migration, API endpoint, JavaScript framework, dependency, difficulty field, sort control, favourite feature, or recommendation feature.
- Reuse the existing `/`, `/edit`, `/u/<username>`, and `/logout` routes; preserve legacy `/lessons` redirects and all existing filters, pagination, deletion behaviour, and `data-testid` values.
- Use the existing white, ink, indigo, amber, and system-font tokens from `_auth_base.html`; do not copy LeetCode assets, trademarks, or brand components.
- Keep HTML autoescaping; pass no user-controlled string into an inline JavaScript literal or a `|safe` expression.
- The profile navigation must point to the authenticated user, including when they are viewing somebody else's profile.
- Desktop must expose table-style columns; narrow screens must hide only the visual column heading and avoid horizontal page overflow.
- Add no dependencies. Run the existing frontend and end-to-end suites before completion.

---

### Task 1: Expose the signed-in user to the shared template and add the top navigation

**Files:**
- Modify: `tests/test_routes_swap.py:111-118`
- Modify: `gdbgui/server/auth.py:36-40`
- Modify: `gdbgui/templates/_auth_base.html:47-73, 313-315`

**Interfaces:**
- Consumes: `current_user_id() -> Optional[int]` from `gdbgui.server.http_util` and `db.user_by_id(user_id: int) -> Optional[sqlite3.Row]`.
- Produces: `navigation_user`, available to every Jinja template as either the authenticated database row or `None`.
- Produces: `data-testid="account-nav-profile"`, an anchor whose `href` is `/u/<authenticated username>`.

- [ ] **Step 1: Write the failing route-render test**

Add this test directly after `test_the_root_renders_the_browse_ui` in `tests/test_routes_swap.py`:

```python
def test_the_root_links_to_the_logged_in_users_profile(flask_app):
    user = register_user(flask_app, display_name="nav_owner")

    response = user.http.get("/")
    body = response.data.decode("utf-8")

    assert 'data-testid="account-nav-profile"' in body
    assert f'href="/u/{user.username}"' in body
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
docker compose -f docker-compose.test.yml build app
docker compose -f docker-compose.test.yml run --rm --no-deps app pytest tests/test_routes_swap.py::test_the_root_links_to_the_logged_in_users_profile -q
```

Expected: FAIL because the rendered root page does not yet contain `account-nav-profile`.

- [ ] **Step 3: Add the single shared template context value**

In `gdbgui/server/auth.py`, below `blueprint = Blueprint(...)`, add this application context processor. Do not add a route or alter the session format:

```python
@blueprint.app_context_processor
def navigation_context():
    user_id = current_user_id()
    user = db.user_by_id(user_id) if user_id is not None else None
    return {"navigation_user": user}
```

In `gdbgui/templates/_auth_base.html`, render the header before `<main>` only when `navigation_user` exists:

```html
<body{% if navigation_user %} class="app-shell"{% endif %}>
  {% if navigation_user %}
    <header class="site-header" data-testid="site-header">
      <nav class="site-nav" aria-label="主要導覽">
        <a class="site-brand" href="{{ url_for('http_routes.lesson_library') }}">教案庫</a>
        <span class="site-nav-spacer"></span>
        <a href="{{ url_for('http_routes.gdbgui') }}">開啟除錯器</a>
        <a class="site-account"
           href="{{ url_for('auth.profile', username=navigation_user['username']) }}"
           data-testid="account-nav-profile">@{{ navigation_user["username"] }}</a>
        <a href="{{ url_for('auth.logout') }}">登出</a>
      </nav>
    </header>
  {% endif %}
  <main class="card">
```

Replace the existing unconditional `<body>` and `<main>` opening tags with this block; retain the existing `</main>` and all page body blocks. Add CSS that keeps anonymous pages centred while signed-in pages use an edge-to-edge header and a centred content width:

```css
body.app-shell { display: block; padding: 0 1rem 2rem; }
.site-header { width: min(74rem, 100%); margin: 0 auto; }
.site-nav { display: flex; align-items: center; gap: 0.9rem; min-height: 3.75rem; }
.site-nav-spacer { flex: 1; }
.site-brand { color: var(--ink); font-family: var(--font-display); font-weight: 650; text-decoration: none; }
.site-account { font-family: var(--font-mono); }
body.app-shell .card { margin: 1.25rem auto 0; }
```

At `max-width: 640px`, allow `.site-nav` to wrap, keep the brand first, and retain focus outlines supplied by the existing anchor rule.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```powershell
docker compose -f docker-compose.test.yml build app
docker compose -f docker-compose.test.yml run --rm --no-deps app pytest tests/test_routes_swap.py::test_the_root_links_to_the_logged_in_users_profile -q
```

Expected: PASS.

- [ ] **Step 5: Commit the navigation slice**

```powershell
git add tests/test_routes_swap.py gdbgui/server/auth.py gdbgui/templates/_auth_base.html
git commit -m "feat: add signed-in profile navigation"
```

### Task 2: Turn the lesson library into the responsive workbench

**Files:**
- Modify: `gdbgui/templates/_auth_base.html:164-270`
- Modify: `gdbgui/templates/lessons.html:7-116`
- Create: `e2e/tests/zz_lesson_library_layout.spec.ts`

**Interfaces:**
- Consumes: unchanged `lessons`, `lesson_tags`, `facets`, `selected_tags`, `page`, `last_page`, `current_user_id`, and `csrf_token` template values.
- Consumes: the Task 1 `site-header` and `account-nav-profile` selector.
- Produces: `data-testid="lesson-browse-columns"` for the desktop column header while preserving every existing `lesson-browse-*`, `lesson-delete`, and pagination selector.

- [ ] **Step 1: Write the failing browser checks**

Create `e2e/tests/zz_lesson_library_layout.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

test('the library workbench exposes its account, search, and desktop columns', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-columns')).toBeVisible();
});

test('the library workbench does not overflow a phone viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});
```

- [ ] **Step 2: Run the new browser checks to verify they fail**

Run:

```powershell
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from e2e
```

Expected: FAIL because `lesson-browse-columns` does not exist.

- [ ] **Step 3: Restructure only the library markup and CSS**

In `gdbgui/templates/lessons.html`:

1. Change its card override to `--card-width: 74rem`.
2. Replace the title and lede with a `library-heading` wrapper containing the existing count and a visible `開啟除錯器` link to `http_routes.gdbgui`.
3. Keep the existing search form, hidden `tag` inputs, tag URL macro, facets, empty state, pager, delete script, and all existing test ids unchanged.
4. Immediately before the existing `<ul class="listing">`, add this decorative desktop heading:

```html
<div class="library-columns" aria-hidden="true" data-testid="lesson-browse-columns">
  <span>#</span><span>教案</span><span>作者</span><span>更新</span><span></span>
</div>
```

5. Within each existing lesson `<li>`, retain the gutter and title link, but move the author link, time, and tags into independent grid children in this order: title/tags, author, update time, optional delete action. Keep `lesson-browse-author`, `lesson-browse-tag`, and `lesson-delete` on their current interactive elements.
6. Remove the bottom `.nav` block because its debugger and logout links now live in the signed-in header from Task 1.

In `_auth_base.html`, replace the two-column `.row` styles only for `.listing .lesson-row` and add scoped workbench styles:

```css
.library-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: start; margin-bottom: 1.4rem; }
.library-columns, .listing .lesson-row { display: grid; grid-template-columns: 3.25rem minmax(0, 1fr) minmax(7rem, .34fr) 7.5rem auto; }
.library-columns { border-bottom: 1px solid var(--struct-border); color: var(--ink-faint); font-size: .68rem; font-weight: 600; letter-spacing: .08em; padding: .45rem 0; text-transform: uppercase; }
.listing .lesson-row { align-items: center; min-height: 4.5rem; }
.listing .lesson-row .row-main { padding-right: .9rem; }
.lesson-row .row-author, .lesson-row .row-updated { color: var(--ink-soft); font-size: .82rem; min-width: 0; overflow-wrap: anywhere; }
.lesson-row .row-actions { padding-right: .75rem; text-align: right; }
@media (max-width: 640px) {
  .library-heading { align-items: stretch; flex-direction: column; }
  .library-columns { display: none; }
  .listing .lesson-row { grid-template-columns: 2.6rem minmax(0, 1fr) auto; align-items: start; }
  .lesson-row .row-author, .lesson-row .row-updated { grid-column: 2; margin-top: .1rem; }
  .lesson-row .row-actions { grid-column: 3; grid-row: 1 / span 3; padding-top: .8rem; }
}
```

Do not change the server route, request parameter names, query construction, delete endpoint, or inline delete script.

- [ ] **Step 4: Run the browser checks to verify they pass**

Run:

```powershell
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from e2e
```

Expected: PASS, including the new desktop-column and phone-overflow checks.

- [ ] **Step 5: Run the focused server regression tests**

Run:

```powershell
docker compose -f docker-compose.test.yml build app
docker compose -f docker-compose.test.yml run --rm --no-deps app pytest tests/test_routes_swap.py tests/test_lesson_sharing.py tests/test_tags_api.py -q
```

Expected: PASS; search, multi-tag filters, pagination, ownership markers, profile links, tags, and deletion continue to work.

- [ ] **Step 6: Commit the workbench slice**

```powershell
git add gdbgui/templates/_auth_base.html gdbgui/templates/lessons.html e2e/tests/zz_lesson_library_layout.spec.ts
git commit -m "feat: redesign lesson library workbench"
```

### Task 3: Perform the full project verification and visual handoff

**Files:**
- Modify: none.

**Interfaces:**
- Consumes: the committed navigation and workbench slices from Tasks 1 and 2.
- Produces: evidence that the existing frontend unit suite and full end-to-end suite remain compatible with the server-rendered library.

- [ ] **Step 1: Run the existing frontend unit suite**

Run:

```powershell
npm test -- --runInBand
```

Expected: all Jest suites pass.

- [ ] **Step 2: Run the full end-to-end suite from a fresh image**

Run:

```powershell
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from e2e
docker compose -f docker-compose.test.yml down --volumes
```

Expected: all Playwright specifications pass and Compose returns the e2e service's zero exit code.

- [ ] **Step 3: Inspect the two target viewport states**

Open the signed-in library at 1280 px and 390 px wide. Confirm the desktop column headings align with lesson rows; on the phone width, confirm the heading is hidden, profile and search controls remain visible, and no horizontal scrollbar appears.

- [ ] **Step 4: Commit only if a verification-only correction was necessary**

If the verification steps required a CSS or test correction, commit the exact changed files:

```powershell
git add gdbgui/templates/_auth_base.html gdbgui/templates/lessons.html e2e/tests/zz_lesson_library_layout.spec.ts tests/test_routes_swap.py
git commit -m "fix: polish lesson library workbench"
```

If no file changed, do not create an empty commit.
