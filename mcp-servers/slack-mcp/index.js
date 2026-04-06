#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { WebClient } = require("@slack/web-api");
const fs = require("fs");
const path = require("path");

// Load token from env file
const envPath = path.join(
  process.env.HOME,
  ".claude",
  "channels",
  "slack",
  ".env"
);
const envContent = fs.readFileSync(envPath, "utf-8");
const token = envContent
  .split("\n")
  .find((l) => l.startsWith("SLACK_USER_TOKEN="))
  ?.split("=")
  .slice(1)
  .join("=")
  .trim();

if (!token) {
  console.error("No SLACK_USER_TOKEN found in", envPath);
  process.exit(1);
}

const slack = new WebClient(token);

const server = new Server(
  { name: "slack-user", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "slack_send_message",
      description:
        "Send a message to any Slack channel including Slack Connect channels. Uses user token so messages come from Zack.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID (e.g., C03P4D7ALP4)",
          },
          text: { type: "string", description: "Message text (markdown supported)" },
          thread_ts: {
            type: "string",
            description: "Thread timestamp to reply to (optional)",
          },
        },
        required: ["channel_id", "text"],
      },
    },
    {
      name: "slack_upload_file",
      description:
        "Upload a file to any Slack channel including Slack Connect channels.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID to upload to",
          },
          file_path: {
            type: "string",
            description: "Absolute path to the file to upload",
          },
          title: {
            type: "string",
            description: "Title for the file (optional)",
          },
          initial_comment: {
            type: "string",
            description: "Message to post with the file (optional)",
          },
        },
        required: ["channel_id", "file_path"],
      },
    },
    {
      name: "slack_search_channels",
      description:
        "Search for Slack channels by name. Returns channel IDs and names.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for channel name" },
          include_private: {
            type: "boolean",
            description: "Include private channels (default true)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "slack_read_channel",
      description: "Read recent messages from a Slack channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Channel ID to read from" },
          limit: {
            type: "number",
            description: "Number of messages to fetch (default 20, max 100)",
          },
        },
        required: ["channel_id"],
      },
    },
    {
      name: "slack_search_messages",
      description: "Search for messages across all Slack channels.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          count: {
            type: "number",
            description: "Number of results (default 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "slack_read_thread",
      description:
        "Read threaded replies for a given message. Returns all replies in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID where the thread lives",
          },
          thread_ts: {
            type: "string",
            description: "Timestamp of the parent message",
          },
          limit: {
            type: "number",
            description: "Number of replies to fetch (default 50, max 200)",
          },
        },
        required: ["channel_id", "thread_ts"],
      },
    },
    {
      name: "slack_search_users",
      description:
        "Search for Slack users by name or email. Returns matching user profiles.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Name or email to search for",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "slack_search_public_and_private",
      description:
        "Search messages across all public and private channels the user has access to. Uses the same search.messages API but explicitly searches both channel types.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          count: {
            type: "number",
            description: "Number of results (default 20)",
          },
          sort: {
            type: "string",
            description: "Sort order: 'score' or 'timestamp' (default 'score')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "slack_edit_message",
      description:
        "Edit an existing Slack message. Messages can only be edited by the user who posted them.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID where the message is",
          },
          ts: {
            type: "string",
            description: "Timestamp of the message to edit",
          },
          text: {
            type: "string",
            description: "New message text (replaces the entire message)",
          },
        },
        required: ["channel_id", "ts", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "slack_send_message": {
        const result = await slack.chat.postMessage({
          channel: args.channel_id,
          text: args.text,
          ...(args.thread_ts && { thread_ts: args.thread_ts }),
        });
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${args.channel_id}. ts: ${result.ts}`,
            },
          ],
        };
      }

      case "slack_upload_file": {
        const fileContent = fs.readFileSync(args.file_path);
        const fileName = path.basename(args.file_path);
        const result = await slack.filesUploadV2({
          channel_id: args.channel_id,
          file: fileContent,
          filename: fileName,
          title: args.title || fileName,
          initial_comment: args.initial_comment || "",
        });
        return {
          content: [
            {
              type: "text",
              text: `File "${fileName}" uploaded to ${args.channel_id}. ${JSON.stringify(result.file?.permalink || "uploaded")}`,
            },
          ],
        };
      }

      case "slack_search_channels": {
        const types = args.include_private !== false
          ? "public_channel,private_channel"
          : "public_channel";
        const result = await slack.conversations.list({
          types,
          limit: 200,
          exclude_archived: true,
        });
        const query = args.query.toLowerCase();
        const matches = (result.channels || [])
          .filter((c) => c.name.toLowerCase().includes(query))
          .map((c) => ({
            id: c.id,
            name: c.name,
            is_private: c.is_private,
            is_shared: c.is_shared,
            is_ext_shared: c.is_ext_shared,
            num_members: c.num_members,
          }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(matches, null, 2),
            },
          ],
        };
      }

      case "slack_read_channel": {
        const limit = Math.min(args.limit || 20, 100);
        const result = await slack.conversations.history({
          channel: args.channel_id,
          limit,
        });
        const messages = (result.messages || []).reverse().map((m) => ({
          user: m.user,
          text: m.text,
          ts: m.ts,
          thread_ts: m.thread_ts,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      }

      case "slack_search_messages": {
        const result = await slack.search.messages({
          query: args.query,
          count: args.count || 20,
        });
        const matches = (result.messages?.matches || []).map((m) => ({
          channel: m.channel?.name,
          channel_id: m.channel?.id,
          user: m.user,
          text: m.text,
          ts: m.ts,
          permalink: m.permalink,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
        };
      }

      case "slack_read_thread": {
        const limit = Math.min(args.limit || 50, 200);
        const result = await slack.conversations.replies({
          channel: args.channel_id,
          ts: args.thread_ts,
          limit,
        });
        const messages = (result.messages || []).map((m) => ({
          user: m.user,
          text: m.text,
          ts: m.ts,
          reply_count: m.reply_count,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      }

      case "slack_search_users": {
        const result = await slack.users.list();
        const query = args.query.toLowerCase();
        const matches = (result.members || [])
          .filter(
            (u) =>
              !u.deleted &&
              !u.is_bot &&
              (u.real_name?.toLowerCase().includes(query) ||
                u.name?.toLowerCase().includes(query) ||
                u.profile?.email?.toLowerCase().includes(query) ||
                u.profile?.display_name?.toLowerCase().includes(query))
          )
          .map((u) => ({
            id: u.id,
            name: u.name,
            real_name: u.real_name,
            display_name: u.profile?.display_name,
            email: u.profile?.email,
            title: u.profile?.title,
            is_admin: u.is_admin,
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
        };
      }

      case "slack_search_public_and_private": {
        const result = await slack.search.messages({
          query: args.query,
          count: args.count || 20,
          sort: args.sort || "score",
        });
        const matches = (result.messages?.matches || []).map((m) => ({
          channel: m.channel?.name,
          channel_id: m.channel?.id,
          channel_is_private: m.channel?.is_private,
          user: m.user,
          username: m.username,
          text: m.text,
          ts: m.ts,
          thread_ts: m.thread_ts,
          permalink: m.permalink,
        }));
        return {
          content: [
            {
              type: "text",
              text: `Found ${matches.length} results across public and private channels:\n${JSON.stringify(matches, null, 2)}`,
            },
          ],
        };
      }

      case "slack_edit_message": {
        const result = await slack.chat.update({
          channel: args.channel_id,
          ts: args.ts,
          text: args.text,
        });
        return {
          content: [
            {
              type: "text",
              text: `Message updated in ${args.channel_id}. ts: ${result.ts}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Slack API error: ${error.message}\n${error.data ? JSON.stringify(error.data) : ""}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
