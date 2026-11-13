# Girls Day Out 3.0 ticket registration

**Event** · Saturday, 5 December 2026 · Hall of Celebration, Okpanam Road, Asaba

The organiser shares a one-time registration link after confirming payment separately. Guests open the link, submit their details and download a personalised PNG. The organiser can generate individual links or batches, copy links for WhatsApp, filter links by status and view attendees.

## Run locally

Requires Node.js 22.12 or newer.

~~~sh
npm ci
npm test
npm run dev
~~~

The registration page is at the root URL and the organiser dashboard is at the same URL with `#admin`. To connect the site to a deployed backend, copy `.env.example` to `.env.local`, replace the example URL with the Apps Script `/exec` URL and restart Vite. The event page can open before a backend is configured.

## Set up Google Sheets and Apps Script

1. Create a Google spreadsheet under the organiser’s Google account. Leave **General access** set to **Restricted**. Copy its ID from between `/d/` and `/edit` in its URL.
2. Open **Extensions → Apps Script** in that spreadsheet. Replace the default `Code.gs` with [backend/Code.gs](backend/Code.gs).
3. In Apps Script, open **Project Settings** and enable **Show “appsscript.json” manifest file in editor**. Replace the manifest with [backend/appsscript.json](backend/appsscript.json). Check that **Sheets** appears under **Services** in the editor. If the script uses a standard Google Cloud project, enable **Google Sheets API** in that project's API Library as well.
4. Run `npm run setup:secrets` locally. Save the generated admin password privately. In Apps Script **Project Settings → Script properties**, add `SPREADSHEET_ID`, `ADMIN_PASSWORD_SHA256` and `APP_SECRET`. Copy the generated property values exactly. The admin password and both secret properties belong outside the frontend and source control.
5. In the editor select `setupSpreadsheet` and click **Run**. Authorise the Sheets permission when Google prompts. Verify the two tabs and headers below. Setup can be run again and preserves existing rows.
6. Select **Deploy → New deployment → Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone** so guests can register without a Google login. Deploy and copy the `/exec` URL. If your Workspace restricts anonymous web apps, use an organiser-controlled account that permits this setting. Keep the spreadsheet itself private.
7. On later backend changes, use **Deploy → Manage deployments → Edit → New version → Deploy** to retain the URL. Keep one Apps Script project per spreadsheet so its script lock covers every writer.

| Tab | Columns |
| --- | --- |
| RegistrationCodes | Code, Status, CreatedAt, RedeemedAt, RegistrationID |
| Registrations | RegistrationID, FullName, ChildAge, Phone, Email, RegistrationCode, TicketNumber, RegisteredAt, ParentAddress, ParentName, ParentPhone, ParentEmail |

To upgrade an existing deployment, update Code.gs and run setupSpreadsheet before deploying the new version. It adds any missing registration columns and hides the legacy contact columns. Existing values are preserved for ticket recovery. New registrations collect the child’s name and age, and the parent’s name, phone number and email address. Publish the updated frontend after the new Apps Script version is live.

The application manages both tabs. Use the dashboard or a separate copy for filtering, sorting or reporting. Avoid editing, deleting or rearranging the live rows while the app is accepting registrations.

## Deploy the frontend

Set `VITE_APPS_SCRIPT_URL` to the `/exec` URL in the static host's build environment or in your local `.env.local`. Run `npm ci` and `npm run build`, then publish the contents of `dist/` to an HTTPS static host. For a Git-connected static host, use `npm run build` as the build command and `dist` as the publish directory. Fragment-based links work on static hosting without rewrite rules.

Open `https://YOUR-SITE/#admin` and sign in with the generated password. Select **Generate one link**, then **Copy link** and send the URL in WhatsApp. The site checks the link automatically and opens the attendee form. The link stays usable until the registration is saved, so opening or previewing it does not use it up. Each link can register one attendee.

## Verify the deployed connection

The browser posts a simple `text/plain;charset=UTF-8` request with a JSON body and no cookies or authorization headers. This avoids a CORS preflight. Apps Script Content Service redirects to `script.googleusercontent.com`; the browser follows the redirect and needs a CORS-readable response across both hops. [Google Content Service documentation](https://developers.google.com/apps-script/guides/content#redirects) · [MDN CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

1. With `VITE_APPS_SCRIPT_URL` set and optionally `GDO_FRONTEND_ORIGIN` set to your site origin such as `https://tickets.example.com` (no trailing slash), run `npm run test:deployment`. This checks the anonymous redirect, Sheets headers and, when the origin is provided, the CORS response headers. It does not write attendee data.
2. From the deployed site in a private browser window, generate a test link using the dashboard. Open the link in a fresh private session and confirm that it goes straight to the attendee form. Register a synthetic attendee and download the PNG. Confirm the name and number on the PNG and the matching rows in both sheets. Refresh the customer tab and download again. Open the same link in a different session and confirm that it is refused. Check the browser Network panel if anything fails. A sign-in redirect usually means the web app is not deployed for anonymous access. The expected network trace starts with a POST to `/exec` and follows the Content Service redirect to a readable JSON response.
3. To exercise live simultaneous requests, use a separate test spreadsheet and deployment. Privately set `GDO_SMOKE_ADMIN_PASSWORD` and `GDO_SMOKE_WRITE=1`, then run `npm run test:deployment`. This adds two synthetic registrations and checks that exactly one competing submission wins, a retry returns the same ticket and a second link produces a different ticket number. Clear the smoke-test password from your shell afterwards.

The local tests run the actual Apps Script source against an in-memory Google services emulator. Separate workers contend for the same lock. The tests also cover validation, admin access, batch retry, atomic write failure, lost responses and duplicate prevention.

## Ticket artwork and retries

The original JPEG is [public/ticket-template.jpg](public/ticket-template.jpg). The canvas keeps the source dimensions. It covers the sample name inside the existing white box, renders the submitted name in uppercase serif text and places the server-assigned number clockwise under the vertical ticket label. The field coordinates are in [src/ticket-layout.json](src/ticket-layout.json).

The browser keeps a pending submission and its random retry key in the current tab session. If a response is lost, **Retry registration** submits the same key. Once a ticket is returned, rendering and downloads are local to the browser. Refreshing that tab can restore the ticket for up to 24 hours. Guests should download the PNG before closing the tab.

The backend holds a script lock while it checks the link’s token, assigns the next ticket number and writes both tabs in one [atomic Sheets API batch](https://developers.google.com/workspace/sheets/api/guides/batch#batch_details). Script Cache provides short-lived admin sessions and basic shared rate limits. Apps Script and Sheets quotas still apply. If a quota or a temporary network error interrupts registration, retry in the same tab.
