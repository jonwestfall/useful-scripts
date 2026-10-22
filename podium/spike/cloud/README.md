# Cloud spike (issue #308)

Throwaway tests for the free cloud setup in
[issue #308](https://github.com/jonwestfall/useful-scripts/issues/308): Podium's
files in OneDrive Personal or Google Drive, and polls and Guest View codes on a
free Supabase project. Nothing here is part of Podium yet, and nothing here
touches Podium's own data. Delete this folder once the issue's plan is settled.

| Question | How it is answered | Status |
| --- | --- | --- |
| 1. Do OneDrive and Google sign-in work from a static site? | `index.html`, **Sign in** in each panel | Needs real accounts: your turn |
| 2. Does Google renew quietly in Safari on an iPad for a whole class? | `index.html`, Google **Renewal soak** on the iPad | Needs the iPad: your turn |
| 3. Does OneDrive's app folder work on a non-English account? | `index.html`, OneDrive **App folder** | Needs such an account, if you have one |
| 4. Can the display read a 50 MB PDF and a video from each drive? | `index.html`, **Upload and read back a file…** on the classroom PC | Needs real accounts: your turn |
| 5. Can Supabase compute Podium's link codes and run polls and Guest View codes? | `supabase.sql` + `check-sql.mjs` against Postgres; `index.html` against a real project | **Answered: yes.** 26 of 26 checks pass on Postgres 16, codes match for 200 of 200 keys. A real project still to try. |

## 1. Set up the three services (once, about 20 minutes)

The page must be opened from the address you register below. The GitHub Pages
copy of this repository is the natural one, for example
`https://<user>.github.io/useful-scripts/podium/spike/cloud/`, if Pages serves
this repository. Any https address works, and `http://localhost` works for
desktop tests. The page prints its own address at the top of **Results**:
register exactly that.

**OneDrive Personal** (Microsoft Entra, free):

1. [Entra admin center](https://entra.microsoft.com) → App registrations → New registration.
2. Name: `Podium`. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Single-page application**, the page's address.
4. API permissions → Add → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder`. (`openid` and `offline_access` are there by default.)
5. Copy the **Application (client) ID** into the page.

**Google Drive** (Google Cloud, free):

1. [Google Cloud console](https://console.cloud.google.com) → New project `Podium`.
2. APIs & Services → Library → enable **Google Drive API**.
3. OAuth consent screen: External, Testing, add your own Google account as a test user. Scopes: add `.../auth/drive.file` only.
4. Credentials → Create credentials → OAuth client ID → **Web application**. Authorized JavaScript origins: the page's origin (scheme and host only, e.g. `https://<user>.github.io`).
5. Copy the **client ID** into the page.

**Supabase** (free project):

1. [Supabase](https://supabase.com) → New project.
2. SQL editor → paste all of `supabase.sql` → Run. (Running it again is safe.)
3. Project Settings → API: copy the **Project URL** and the **anon public** key into the page.

## 2. Run the tests, and record what happens

On each device, run the buttons in order, then **Copy results** and paste them
into a comment on issue #308, saying which device it was.

| Device | Buttons | Watch for |
| --- | --- | --- |
| Desktop (your office computer) | Everything once; for **Upload and read back**, a 50 MB PDF and then a video | Any "unverified app" screen from Google, and what it said |
| Classroom PC (as the display) | Sign in to both, **Upload and read back** with the same PDF and video | Download speed on the classroom network; that the PDF draws and the video plays |
| iPad (as the controller) | Sign in to both, then **Renewal soak** for each (every 10 min, for 75 min) | Whether any renewal needed a pop-up, or failed; keep the iPad awake and the tab in front |
| A phone | Supabase: **Run a poll** and **Guest View codes** | Timings on mobile data |

**What decides the plan:**

| Result | Then |
| --- | --- |
| Google's quiet renewal fails on the iPad | The controller signs in to OneDrive (24-hour renewal), or Google sign-in happens before class and Podium warns ahead of expiry |
| OneDrive's app folder misbehaves on a localized account | Add the `Files.Read` workaround from the issue, or use a named folder with `Files.ReadWrite` |
| The classroom PC downloads too slowly | The display caches each lecture's media ahead of time (when the lecture is opened) |
| A Supabase call is slow on mobile data | Phones poll less often, or results move to Supabase Realtime |

## Checking the SQL without Supabase

`check-sql.mjs` runs `supabase.sql` against any Postgres and checks it against
Podium's own code. It is not in CI, which has no Postgres.

```sh
DATABASE_URL=postgres://user:pass@localhost/podium_spike node spike/cloud/check-sql.mjs
```

It creates Supabase's `anon` and `authenticated` roles if they are missing.
The current result, on Postgres 16:

- the script runs twice over itself
- poll and viewer link codes match Podium's for 200 of 200 random keys
- the public role cannot read the tables or call the private helpers
- polls behave as the server's do: four-character codes, a token to ask, one answer per phone with the last counting, earlier questions refused, closed polls refused, results only with the token
- planned poll links open under their code, again and again
- Guest View codes behave as the server's do: six-character codes kept by the same display, refused to another, real-room links refused, planned codes claimed with their key, early visitors told to wait, release at stand-down

## Not covered by the spike

Q&A, timed polls, attendance, per-IP lookup limits, and how phones hear about a
new question (the server pushes it; Supabase would use Realtime or polling).
Those are for step 4 of the plan, once the questions above are answered.
