# Zoom Transcript MCP Server - Setup Instructions

## Overview

The `zoom_transcript_mcp` server provides tools for accessing Zoom cloud recordings and transcripts:
- **list_meetings** -- List Zoom meetings that have cloud recordings
- **download_transcript** -- Download transcript for a specific meeting
- **get_recent_transcripts** -- Fetch transcripts from recent meetings
- **search_transcripts** -- Search across downloaded transcript content

Server location: `~/.claude/mcp-servers/zoom_transcript_mcp/`
Transcripts stored in: `~/.claude/mcp-servers/zoom_transcript_mcp/transcripts/`

## Step 1: Create a Server-to-Server OAuth App in Zoom

1. Go to https://marketplace.zoom.us/
2. Click **Develop** > **Build App**
3. Choose **Server-to-Server OAuth** as the app type
4. Click **Create**

## Step 2: Fill in App Information

1. Give the app a name (e.g., "Claude Transcript Reader")
2. Fill in the required company and developer contact information
3. Click **Continue**

## Step 3: Note Your Credentials

On the **App Credentials** page, copy:
- **Account ID** -- this is your `ZOOM_ACCOUNT_ID`
- **Client ID** -- this is your `ZOOM_CLIENT_ID`
- **Client Secret** -- this is your `ZOOM_CLIENT_SECRET`

## Step 4: Add Required Scopes

Go to the **Scopes** section and add these scopes:

- `cloud_recording:read:list_account_recordings:admin`
- `cloud_recording:read:recording:admin`
- `cloud_recording:read:list_user_recordings:admin`

These allow the app to list recordings and download transcripts for the account.

## Step 5: Activate the App

1. Review all sections are complete
2. Click **Activate your app**
3. The app is now ready to use

## Step 6: Update Claude Code Environment Variables

Run these commands, replacing the placeholder values with your actual credentials:

```bash
claude mcp remove --scope user zoom-transcripts
claude mcp add --scope user zoom-transcripts \
  -e ZOOM_ACCOUNT_ID=your-actual-account-id \
  -e ZOOM_CLIENT_ID=your-actual-client-id \
  -e ZOOM_CLIENT_SECRET=your-actual-client-secret \
  -e TRANSCRIPTS_DIR=/Users/YOUR_USER/.claude/mcp-servers/zoom_transcript_mcp/transcripts \
  -- node /Users/YOUR_USER/.claude/mcp-servers/zoom_transcript_mcp/build/index.js
```

## Notes

- Server-to-Server OAuth does not require user login -- it authenticates as the app itself
- Transcripts are cached locally in the TRANSCRIPTS_DIR for faster search
- The app needs cloud recording enabled on the Zoom account for transcripts to be available
- If you rebuild the server after updates: `cd ~/.claude/mcp-servers/zoom_transcript_mcp && git pull && npm install && npm run build`
