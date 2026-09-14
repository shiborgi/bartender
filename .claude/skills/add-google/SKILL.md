---
name: add-google
description: Connect a selected Google account to one or more NanoClaw agent groups through the install gateway. Use for Google Drive, Calendar, Gmail, People, Chat, or Tasks integrations.
---

# Add Google Workspace

This skill configures Google capabilities at the **gateway**, never in an
agent container. Drive, Calendar, Gmail and Tasks use the gateway's built-in
REST adapters so credentials stay at the gateway and the installation does
not depend on Google's Workspace MCP preview. People and Chat may be
configured as remote MCP servers when their endpoints are available to the
operator's Google Cloud project.

```nc:operator
This workflow needs Google Cloud OAuth configuration and browser consent. Continue in this guided skill; do not paste credentials into chat.
```

## 1. Choose scope

Ask for the Google products, the exact Google account email, and the agent
groups that may use them. Default to read-only scopes unless the operator
explicitly asks for writes. Do not use the wildcard `"*"` in the gateway
agent policy for Google routes.

Built-in route names and minimum OAuth scopes:

| Product  | Route             | Minimum scope for the built-in tools             |
| -------- | ----------------- | ------------------------------------------------ |
| Drive    | `google-drive`    | `https://www.googleapis.com/auth/drive`          |
| Calendar | `google-calendar` | `https://www.googleapis.com/auth/calendar`       |
| Gmail    | `google-gmail`    | `https://www.googleapis.com/auth/gmail.readonly` |
| Tasks    | `google-tasks`    | `https://www.googleapis.com/auth/tasks`          |

The Gmail adapter is deliberately read-only. It exposes `get_profile`,
`list_labels`, `search_messages`, `get_message`, `get_thread`, and
`list_history`. Message reads decode Gmail's MIME/base64url representation,
prefer the plain-text alternative, normalize structured HTML to text, and do
not expose raw HTML or attachment contents.

## 2. Google Cloud prerequisites

Create/select one Google Cloud project, enable the selected product APIs,
configure the OAuth consent screen, add the selected account as a test user
when applicable, and create a **Desktop** OAuth client. Gmail requires the
Gmail API itself; the built-in route does not require a Workspace MCP preview
API. The gateway uses a loopback callback and PKCE. Never ask the operator to
paste a refresh token or client secret into chat.

## 3. Configure the gateway

`gateway/config/gateway.json` and `gateway/config/secrets.env` are created by
the gateway bootstrap if absent. Add one named `oauthProfiles` entry with:

```json
"google-primary": {
  "provider": "google",
  "expectedEmail": "operator@example.com",
  "clientIdSecret": "GOOGLE_OAUTH_CLIENT_ID",
  "clientSecretSecret": "GOOGLE_OAUTH_CLIENT_SECRET",
  "refreshTokenSecret": "GOOGLE_PRIMARY_REFRESH_TOKEN",
  "scopes": ["openid", "email"]
}
```

Append only the selected API scopes. Add each selected route under
`mcpServers` with `auth: { "kind": "oauth2", "profile": "google-primary" }`.
For Gmail, the complete route entry is:

```json
"google-gmail": {
  "builtin": "google-gmail",
  "auth": { "kind": "oauth2", "profile": "google-primary" }
}
```

Write client ID and client secret to `gateway/config/secrets.env`, keep it
mode `0600`, and leave the refresh-token value blank. Add exact `agents`
entries for every selected agent group, listing only its permitted Google
routes.

## 4. Authorize and register

Run the local OAuth flow from the repository root:

```bash
pnpm exec tsx scripts/google-oauth-connect.ts google-primary
```

It opens the browser, verifies `expectedEmail`, and writes the refresh token
only to `gateway/config/secrets.env`. Run it again after adding the Gmail scope
to an existing profile: an old refresh token does not acquire a newly declared
scope by itself.

For each selected group and route, register the gateway route and restart:

```bash
ncl groups config add-mcp-server --id <group-id> --name google-drive --gateway-route google-drive
ncl groups config add-mcp-server --id <group-id> --name google-gmail --gateway-route google-gmail
ncl groups restart --id <group-id>
```

## 5. Verify

Confirm the group config contains only `type: "gateway"` and the logical
route, then ask the agent to list tools and perform one least-privileged call.
For Gmail, call `get_profile` first and a narrowly bounded `search_messages`
query second. The agent must not be able to read the client secret, refresh
token, or a public Google bearer token.

## Tasks

Do not claim Tasks is installed merely by adding the `tasks` OAuth scope.
There is no official Google Tasks remote MCP at this time. The built-in
gateway adapter supplies it; register `google-tasks` exactly as the other
logical routes.

## Removal

See [REMOVE.md](REMOVE.md). Revoke the Google grant after removing every
route; deleting only the local refresh token does not revoke existing access.
