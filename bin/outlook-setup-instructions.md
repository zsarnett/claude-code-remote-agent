# Outlook MCP Server - Azure Setup Instructions

## Overview

The `outlook-mcp` server (npm package v2.4.2) provides 75+ tools for Microsoft 365:
- Email (read, search, send, draft, forward, reply, attachments, categories, rules)
- Calendar (list, create, update, delete events, accept/decline)
- Contacts (CRUD, folder management)
- Tasks (Microsoft To-Do integration)
- Teams (teams, channels, messages, chats, online meetings, presence)

## Step 1: Register an Azure App

1. Go to https://portal.azure.com
2. Navigate to **Azure Active Directory** > **App registrations** > **New registration**
3. Name: `Outlook MCP Server`
4. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
5. Redirect URI: Select **Web** and enter: `http://localhost:3333/auth/callback`
6. Click **Register**

## Step 2: Note Your IDs

After registration, copy these from the app's **Overview** page:
- **Application (client) ID** -- this is your `MS_CLIENT_ID`
- **Directory (tenant) ID** -- this is your `MS_TENANT_ID`

## Step 3: Create a Client Secret

1. Go to **Certificates & secrets** > **Client secrets** > **New client secret**
2. Add a description (e.g., "Claude MCP") and set expiration
3. Click **Add**
4. **IMMEDIATELY** copy the secret **Value** (not the Secret ID) -- this is your `MS_CLIENT_SECRET`
   - You cannot view this value again after leaving the page

## Step 4: Configure API Permissions

Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**.

Add all of the following:

### Core
- `offline_access`
- `User.Read`

### Email
- `Mail.Read`
- `Mail.ReadWrite`
- `Mail.Send`

### Calendar
- `Calendars.Read`
- `Calendars.ReadWrite`

### Contacts
- `Contacts.Read`
- `Contacts.ReadWrite`

### Tasks
- `Tasks.Read`
- `Tasks.ReadWrite`

### Teams (optional, add if you use Teams)
- `Team.ReadBasic.All`
- `ChannelMessage.Send`
- `Chat.ReadWrite`
- `ChatMessage.Send`
- `Presence.Read`
- `OnlineMeetings.ReadWrite`

After adding permissions, click **Grant admin consent** if you have admin rights.

## Step 5: Update Claude Code Environment Variables

Run these commands, replacing the placeholder values with your actual credentials:

```bash
claude mcp remove --scope user outlook-mcp
claude mcp add --scope user outlook-mcp \
  -e MS_CLIENT_ID=your-actual-client-id \
  -e MS_CLIENT_SECRET=your-actual-client-secret \
  -e MS_TENANT_ID=your-actual-tenant-id \
  -- npx outlook-mcp
```

## Step 6: Authenticate

After configuring the credentials, use the `authenticate` tool in Claude to complete the OAuth flow. This will:
1. Open a browser window for Microsoft login
2. Save tokens to `~/.outlook-mcp-tokens.json`
3. Tokens auto-refresh using the offline_access scope

## Troubleshooting

- If authentication fails, run `npm run auth-server` from the outlook-mcp package directory to start the auth callback server manually
- Enable debug logging: set env var `DEBUG=outlook-mcp`
- Test mode (no real API calls): set env var `USE_TEST_MODE=true`
