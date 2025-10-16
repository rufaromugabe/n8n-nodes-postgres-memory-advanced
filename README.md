![Banner image](https://user-images.githubusercontent.com/10284570/173569848-c624317f-42b1-45a6-ab09-f0ea3c247648.png)

# n8n-nodes-postgres-advanced-memory

This is an n8n community node that provides advanced PostgreSQL chat memory functionality for AI agents with **schema support**.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation) | [Operations](#operations) | [Credentials](#credentials) | [Usage](#usage) | [Resources](#resources)

## Features

✅ **Schema Support** - Organize chat histories across different PostgreSQL schemas  
✅ **Auto Schema & Table Creation** - Automatically creates schemas and tables if they don't exist  
✅ **Session Tracking** - Optional thread management with metadata table for conversation lists  
✅ **Working Memory** - Persistent user information with extensible JSON schema (requires manual tool setup)  
✅ **Working Memory Tool** - Dedicated node for structured memory updates (**must be manually connected**)

✅ **Semantic Search** - Advanced RAG-based memory retrieval with dynamic node shape

## 🚨 Working Memory Setup Required

> **If you enable Working Memory, you MUST manually add the Working Memory Tool node:**
>
> 1. Add **"Working Memory Tool"** node to your workflow
> 2. Connect it to your **AI Agent** as a tool input
> 3. Use same **Postgres credentials** and **session settings**

## Screenshots

### Main Configuration

![Main Node Configuration](nodes/MemoryPostgresAdvanced/docs/main-node.png)

### Schema and Session Setup

![Schema and Session Configuration](nodes/MemoryPostgresAdvanced/docs/Schema%20and%20session%20defination.png)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

### npm

```bash
npm install n8n-nodes-postgres-advanced-memory
```

### n8n UI

1. Go to **Settings** > **Community Nodes**
2. Click **Install**
3. Enter `n8n-nodes-postgres-advanced-memory`
4. Click **Install**

## Prerequisites

- n8n version 1.0.0 or higher
- PostgreSQL 9.5 or higher
- Valid PostgreSQL credentials

## Operations

### Postgres Memory+

Store and retrieve chat history in a PostgreSQL database with advanced schema configuration.

#### Main Configuration

![Main Node Configuration](nodes/MemoryPostgresAdvanced/docs/main-node.png)

#### Configuration Options

| Option                      | Type    | Default                  | Description                                                                        |
| --------------------------- | ------- | ------------------------ | ---------------------------------------------------------------------------------- |
| **Schema Name**             | string  | `public`                 | PostgreSQL schema where the table is located                                       |
| **Table Name**              | string  | `n8n_chat_histories`     | Name of the table to store chat history                                            |
| **Session Key**             | string  | `={{ $json.sessionId }}` | Identifier for the chat session                                                    |
| **Context Window Length**   | number  | `5`                      | Number of previous messages to retain (v1.1+)                                      |
| **Enable Session Tracking** | boolean | `false`                  | Track sessions in separate table (UI only). Disable if not needed for performance. |
| **Sessions Table Name**     | string  | `n8n_chat_sessions`      | Table name for session metadata (when tracking is enabled)                         |
| **Enable Working Memory**   | boolean | `false`                  | Enable persistent user information with extensible JSON schema                     |
| **Working Memory Template** | JSON    | (user info template)     | JSON template for storing structured user data with extensible fields              |
| **Enable Semantic Search**  | boolean | `false`                  | Enable RAG-based memory retrieval using embeddings                                 |
| **Top K Results**           | number  | `3`                      | Number of semantically similar messages to retrieve                                |
| **Message Range**           | number  | `2`                      | Context messages before/after each semantic match                                  |

## Semantic Search

### How It Works

1. **Enable Feature**: Turn on "Semantic Search" in Options
2. **Connect Vector Store**: Attach your Vector Store node
3. **Set Context Window**: Configure your desired context window length (e.g., 10 messages)
4. **Automatic Embedding**: Messages are embedded using the vector store's internal model
5. **Smart Activation**: Semantic search ONLY runs when context window is full
   - Short conversations: Uses regular memory (instant, no overhead)
   - Long conversations: Automatically retrieves relevant older messages
6. **Natural Injection**: Retrieved messages are injected as actual conversation history

### Configuration

| Option            | Description                                              |
| ----------------- | -------------------------------------------------------- |
| **Top K Results** | Number of similar past messages to retrieve (default: 3) |
| **Message Range** | Include N messages before/after each match (default: 2)  |

### Benefits

- 🔍 **Semantic Understanding**: Finds relevant messages even if wording differs
- 📚 **Long-term Memory**: Retrieves important context from weeks/months ago
- 🎯 **Context-aware**: Returns surrounding messages for better understanding
- ⚡ **Zero Overhead**: No performance impact when context window isn't full
- 🎯 **Smart Activation**: Only searches when there are older messages beyond recent context
- 🔌 **Simple Setup**: Only need Vector Store

### Supported Vector Stores

Works with any n8n vector store node:

- Postgres with pgvector
- Pinecone
- Qdrant
- Supabase
- Chroma
- Weaviate
- In-Memory Vector Store
- And more!

## Auto-Creation Features

The node automatically creates:

1. **Schemas** if they don't exist (for non-`public` schemas)
2. **Chat history table** if it doesn't exist in the specified schema
3. **Sessions table** if session tracking is enabled and table doesn't exist

**Requirements:** Database user needs `CREATE SCHEMA` and `CREATE TABLE` permissions

## Working Memory

> **⚠️ IMPORTANT:** Working Memory requires the **Working Memory Tool** node to be **manually added and connected** to your AI Agent.

This feature allows agents to maintain persistent, structured information about users across conversations using an extensible JSON schema approach.

### 🧠 What is Working Memory?

Working memory is like the agent's scratchpad - it stores long-term user information that should always be available:

- User preferences
- Personal details (name, location, etc.)
- Goals and interests
- Important facts
- Ongoing projects

### How It Works

1. **Enable Feature**: Turn on "Working Memory" in Options (requires Session Tracking)
2. **Add Tool Node**: Manually add **Working Memory Tool** node and connect to AI Agent
3. **Customize Template**: Define the structure of information you want to track
4. **Agent Updates**: Agent uses the Working Memory Tool to update persistent information

### Complete Workflow Setup

```

┌─────────────────────┐
│ Chat Trigger │
│ (Webhook/Chat) │
└──────────┬──────────┘
│
↓
┌─────────────────────┐ ┌──────────────────────┐
│ Postgres Memory+ │ │ Working Memory Tool │
│ • Session Tracking │ │ • Same SessionId │
│ • Working Memory ON │ │ • Same Credentials │
└──────────┬──────────┘ └──────────┬───────────┘
│ │
│ (memory input) │ (tool input)
└──────────┬───────────────────┘
↓
┌─────────────────────┐
│ AI Agent │
│ • Reads memory │
│ • Calls tool │
└──────────┬──────────┘
↓
┌─────────────────────┐
│ Response Output │
└─────────────────────┘

```

![Main Node Configuration](nodes/MemoryPostgresAdvanced/docs/main-node.png)

### Example Usage

**Initial Template:**

```json
{
	"name": "",
	"location": "",
	"occupation": "",
	"interests": [],
	"goals": [],
	"preferences": {}
}
```

**After Conversation:**

```json
{
	"name": "Rufaro",
	"location": "Zimbabwe",
	"occupation": "Developer",
	"interests": ["AI", "Software Development"],
	"goals": ["Build AI applications"],
	"preferences": {},
	"surname": "Mugabe",
	"gender": "male"
}
```

### Storage

Working memory is stored in the sessions table `metadata` column as JSONB:

```sql
metadata: {
  "workingMemory": {
    "name": "Rufaro",
    "location": "Zimbabwe",
    "surname": "Mugabe",
    "gender": "male"
  }
}
```

### Agent Integration

Working memory is provided to the agent as **read-only context** at the start of each conversation. To update working memory, the agent must use the **Working Memory Tool**

### Benefits

- 🧠 **Persistent Memory**: Information persists across all conversations in a thread
- 📝 **Structured**: JSON format provides extensible schema with type safety
- 🔄 **Automatic**: Agents update memory seamlessly
- 🎯 **Contextual**: Always available to the agent for better responses

### Documentation

## Working Memory Tool

A dedicated tool node that gives AI agents explicit control over working memory through tool calls.

### Documentation

For detailed information, see:

- [Working Memory Tool Guide](nodes/WorkingMemoryTool/docs/WORKING_MEMORY_TOOL.md)
- [Tool Quickstart](docs/WORKING_MEMORY_TOOL_QUICKSTART.md)
- [Architecture Overview](docs/WORKING_MEMORY_ARCHITECTURE.md)

## Session Tracking (Thread Management)

Enable session tracking to maintain a separate table with conversation metadata.

> **⚡ Performance Note:** Session tracking is **purely for UI purposes** (building a sessions/threads list). It does NOT affect memory functionality. **Disable it if not needed** for maximum performance!

#### Schema and Session Configuration

![Schema and Session Configuration](nodes/MemoryPostgresAdvanced/docs/Schema%20and%20session%20defination.png)

**Session Table Structure:**

```sql
{
  id: string,              // Session ID (UUID)
  title: string,           // Auto-generated from first 50 chars
  lastMessage: string,     // Preview of last message
  timestamp: Date,         // Last update time
  messageCount: number,    // Total messages in session
  metadata: JSONB,         // Working memory and custom data
  createdAt: Date,         // Session creation time
  updatedAt: Date          // Last modification time
}
```

**Use Cases:**

- Display list of user conversations
- Load specific conversation threads
- Sort by most recent activity
- Show message previews
- Track conversation metrics
- Store working memory (when enabled)

**When to Enable:**

- ✅ Building a chat UI with threads/sessions list
- ✅ Need conversation history management
- ✅ Using Working Memory feature

**When to Disable:**

- ❌ Pure memory functionality (no UI)
- ❌ Maximum performance required
- ❌ Simple single-conversation use cases

## Credentials

## Comparison with Standard Node

| Feature            | Standard Node | Advanced Node |
| ------------------ | ------------- | ------------- |
| Schema Support     | ❌            | ✅            |
| Table Name         | ✅            | ✅            |
| Session Management | ✅            | ✅            |
| Thread Management  | ❌            | ✅            |
| Context Window     | ✅            | ✅            |
| Auto Schema/Table  | ❌            | ✅            |
| Performance Impact | None          | None          |

## Migration from Standard Node

To migrate from the standard Postgres Chat Memory node:

1. Install this advanced node
2. Replace the standard node with the advanced node
3. Add the schema name field (default: `public`)
4. Keep all other settings the same
5. Test thoroughly in a development environment
