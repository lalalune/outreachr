# Founder-owned connector credentials

Outreachr has no shared cloud OAuth application. Each founder creates a public native-desktop client so the local app can request narrowly delegated access without any centrally controlled Outreachr credential. The Application/Client ID and Microsoft tenant are public configuration; an OAuth authorization code, access token, refresh token, client secret, or account password is not.

Never paste an account password into Outreachr. Google Desktop clients can require the client secret issued with the client ID; enter it only in the dedicated password field. Microsoft uses a public desktop client and does not accept a client secret. Authorization runs in the system browser with PKCE, and token exchange and storage stay in the Electron main process.

## Google Workspace

1. [Create or select a Google Cloud project](https://console.cloud.google.com/projectcreate).
2. In the [API Library](https://console.cloud.google.com/apis/library), enable **Gmail API** and **Google Calendar API**.
3. Configure the [Google Auth Platform](https://console.cloud.google.com/auth/overview):
   - complete Branding with an app name, founder support email, and developer contact;
   - under [Audience](https://console.cloud.google.com/auth/audience), choose Internal only for an eligible Google Workspace organization or External for a personal/outside account;
   - when an External app remains in Testing, add the exact founder Google account as a test user;
   - under [Data Access](https://console.cloud.google.com/auth/scopes), declare the scopes listed below.
4. Open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients), create an OAuth client, and select **Desktop app**. Copy the client ID and the Desktop client secret if Google issues one. Google documents this client type in [Create access credentials](https://developers.google.com/workspace/guides/create-credentials#desktop-app) and the [native-app loopback flow](https://developers.google.com/identity/protocols/oauth2/native-app).
5. In Outreachr, open **Settings → Mail & calendar → Google Workspace**, paste the client ID and the issued Desktop client secret, choose whether to enable relationship sync, and select **Save and connect in browser**.
6. In the system browser, select the same Google account, review every requested permission, authorize it, and return to Outreachr. The local callback closes automatically after the response.
7. Select **Test connection**, then **Sync calendar**. If relationship sync is enabled, select **Sync mail history** and let the initial exhaustive reconciliation finish before approving or sending outreach.

Outreachr's minimum Google request is:

- `openid` and `https://www.googleapis.com/auth/userinfo.email` to identify the connected account;
- `https://www.googleapis.com/auth/gmail.send` for founder-approved mail;
- `https://www.googleapis.com/auth/calendar.events.owned` and `https://www.googleapis.com/auth/calendar.events.freebusy` for owned-calendar events and free/busy access;
- offline access so the local app can refresh an expired access token.

Enabling **relationship sync** adds `https://www.googleapis.com/auth/gmail.readonly`. Outreachr uses it for header-only prior-contact, reply, bounce, complaint, and unsubscribe reconciliation; it discards bodies, attachments, and unrelated inbound messages. Research-only use can leave it off. Provider sending fails closed without a completed relationship sync.

Google classifies some Gmail access as sensitive or restricted. A founder-owned, personal-use client may qualify for Google's verification exception, but it can still show an unverified-app warning and user cap. Google states that authorizations for an External app left in Testing expire after seven days; reconnecting weekly is therefore expected in that mode. Review the current [restricted-scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) before changing the publishing status.

## Microsoft 365

1. Open [Microsoft Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), create a registration, and copy its **Application (client) ID**. Microsoft's official walkthrough is [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
2. Choose the account audience deliberately:
   - to support both work/school and personal Microsoft accounts, choose **Accounts in any organizational directory and personal Microsoft accounts** and use tenant `common` in Outreachr;
   - for a single-tenant registration, enter that registration's **Directory (tenant) ID** instead of `common`;
   - do not use `common` to broaden a registration that was intentionally created as single-tenant.
3. Under **Authentication**, add the **Mobile and desktop applications** platform with the exact redirect URI `http://localhost/oauth/callback`, and enable public client flows. Do not create a client secret. Outreachr advertises `localhost` with a temporary port because Microsoft ignores the port for registered localhost native-app redirects; the listener itself remains bound to IPv4 loopback. See Microsoft's [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
4. Under **API permissions**, add delegated Microsoft Graph permissions `User.Read`, `Mail.Send`, and `Calendars.ReadWrite`. Outreachr also requests the standard `openid`, `profile`, `email`, and `offline_access` scopes. Enabling relationship sync adds delegated `Mail.ReadBasic`, which excludes bodies and attachments. Confirm the current definitions in the [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).
5. In Outreachr, open **Settings → Mail & calendar → Microsoft 365**, paste the Application (client) ID, enter `common` or the exact Directory tenant ID, choose relationship sync, and select **Save and connect in browser**.
6. Complete Microsoft sign-in and consent in the system browser. A managed tenant can require administrator approval even though Outreachr requests delegated permissions only.
7. Select **Test connection**, then **Sync calendar**. If relationship sync is enabled, select **Sync mail history** and let the initial exhaustive reconciliation finish before approving or sending outreach.

## Credential storage and renderer boundary

The public client ID, tenant selection, requested scope list, connection status, and connected account label can appear in the renderer and SQLite. OAuth codes and tokens do not. The Google Desktop client secret is write-only: after entry, it is cleared from the form, never returned in bootstrap or public configuration, and used only for Google code exchange and refresh. Saving the same client ID without a new secret retains the encrypted value; changing the client ID or disconnecting removes it. Google documents installed-app client secrets as non-confidential application credentials, but Outreachr still protects the stored value. The main process receives the loopback callback, exchanges the one-time code, and encrypts client secrets, access tokens, and refresh tokens with the operating-system credential facility before ciphertext is stored in SQLite:

- macOS Keychain;
- Windows DPAPI/Credential protection;
- Linux Secret Service, GNOME Keyring, or KWallet.

On Linux, Outreachr refuses persistent credentials when Electron reports `basic_text` or an unknown backend. Unlock or install a supported secret service, restart Outreachr, and reconnect. The app does not downgrade to plaintext storage. Production diagnostics must not contain authorization codes, tokens, message bodies, calendar descriptions, or client secrets.

## Recovery and revocation

- **The browser never returns:** retry within five minutes, allow local loopback traffic, and ensure `localhost` resolves to `127.0.0.1`. Outreachr listens only on loopback and validates the exact method, host, path, state, and one code-or-error response.
- **Google `redirect_uri_mismatch`:** recreate the credential as **Desktop app**, not Web application. A Google Desktop client accepts the temporary `127.0.0.1` loopback URI; do not configure a web redirect.
- **Google `client_secret is missing` or `invalid_client`:** enter the secret from the same Google Desktop client as the client ID, then save and reconnect. Do not use a Web application secret.
- **Google `access_denied` or unverified warning:** confirm the founder account is an allowed test user, the requested scopes are declared, and an organization administrator has not blocked the app.
- **Microsoft `AADSTS50011`:** confirm that the Mobile and desktop platform contains exactly `http://localhost/oauth/callback`; the path is case-sensitive.
- **Microsoft client/tenant error:** confirm the Application ID belongs to the selected registration and that `common` versus the Directory tenant ID matches its supported account types.
- **Expired/revoked grant or `invalid_grant`:** disconnect locally, correct the provider configuration, reconnect, and rerun the initial sync. Also check that the device clock is correct.
- **Connection test or sync fails:** the error remains visible in Settings. Correct the cause and retry; do not create a second provider client unless the existing registration is wrong.

**Disconnect** deletes encrypted local tokens and the Google Desktop client secret but does not revoke the provider-side consent grant. To revoke access as well, remove the app under [Google Account connections](https://myaccount.google.com/connections) or, for a Microsoft work/school account, [Microsoft My Apps](https://myapps.microsoft.com/). An organization administrator may need to revoke admin-consented Microsoft permissions.
