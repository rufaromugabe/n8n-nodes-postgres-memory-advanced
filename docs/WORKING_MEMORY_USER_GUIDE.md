# Working Memory: Building Intelligent Assistants

A practical guide to creating AI assistants that remember your users.

## What You're Building

Imagine building an AI assistant that:

- Remembers your name after you tell it once
- Knows your preferences without asking every time
- Understands your context across different conversations
- Provides personalized responses based on what it knows about you

That's what working memory enables.

## The Problem Without Working Memory

**Traditional Chat (No Memory):**

```
Monday Morning:
You: "Hi, I'm Sarah from New York"
Assistant: "Nice to meet you, Sarah!"

Monday Afternoon (New Conversation):
You: "What's the weather like?"
Assistant: "Where are you located?"
You: "New York... I told you this morning"
Assistant: "I apologize, I don't have access to previous conversations"
```

**With Working Memory:**

```
Monday Morning:
You: "Hi, I'm Sarah from New York"
Assistant: "Nice to meet you, Sarah! I'll remember that."

Monday Afternoon (New Conversation):
You: "What's the weather like?"
Assistant: "Let me check the weather in New York for you, Sarah!"
```

## How It Works

### The Basics

Working memory is like giving your assistant a notebook where it writes down important information about each user:

```json
{
	"name": "Sarah",
	"location": "New York",
	"preferences": {
		"timezone": "EST",
		"language": "English"
	}
}
```

This information:

- **Persists** across conversations
- **Updates** automatically when users share new information
- **Stays available** to the assistant at all times

### Two Types of Memory

#### **Thread-Scoped Memory** (Default)

Each conversation has its own memory.

**Use When:**

- Different conversations are about different topics
- You want context isolation between chats
- Users discuss separate projects or subjects

**Example:**

```
Work Chat: {project: "Website Redesign", deadline: "March 15"}
Personal Chat: {topic: "Vacation Planning", destination: "Hawaii"}
```

#### **User-Scoped Memory** (Advanced)

One memory follows the user everywhere.

**Use When:**

- Building personal assistants
- Creating customer service bots
- Developing educational platforms
- Users should have consistent experience across all chats

**Example:**

```
All Conversations: {
  name: "Sarah",
  location: "New York",
  preferences: {timezone: "EST"},
  goals: ["Learn Spanish", "Plan vacation"]
}
```

## Real-World Examples

### Example 1: Personal Assistant

**What Users Experience:**

```
First Conversation:
User: "My name is Alex and I live in San Francisco"
Assistant: "Nice to meet you, Alex! I'll remember you're in San Francisco."

[Working Memory Updated]
{
  "name": "Alex",
  "location": "San Francisco"
}

Next Day - Different Conversation:
User: "Schedule a meeting for tomorrow at 2pm"
Assistant: "I'll schedule that for 2pm PST (your San Francisco timezone), Alex!"

[Working Memory Used - No need to ask location again]
```

**What You Configure:**

- Enable Session Tracking
- Enable Working Memory
- Set Scope: User-Scoped
- Add User ID: `{{ $json.userId }}`

### Example 2: Customer Service

**What Users Experience:**

```
Support Ticket #1:
Customer: "I'm having issues with my Premium account"
Agent: "Hi! I see you're a Premium customer. Let me help you."

[Working Memory]
{
  "name": "John Smith",
  "accountType": "Premium",
  "previousIssues": ["Billing question - resolved"]
}

Support Ticket #2 (Next Week):
Customer: "I have another question"
Agent: "Welcome back, John! How can I help you today?"

[Agent already knows customer context]
```

**What You Configure:**

- Enable Session Tracking
- Enable Working Memory
- Set Scope: User-Scoped
- Add User ID: `{{ $json.customerId }}`

### Example 3: Educational Platform

**What Users Experience:**

```
Monday Lesson:
Student: "I'm struggling with async/await"
Tutor: "No problem! Let's work on that together."

[Working Memory]
{
  "name": "Maria",
  "course": "JavaScript Fundamentals",
  "completed": ["Variables", "Functions", "Objects"],
  "challenges": ["Async programming"]
}

Wednesday Lesson:
Tutor: "Hi Maria! Ready to practice more async/await?"
Student: "Yes! How did you know?"
Tutor: "I remember you wanted to work on that!"

[Personalized learning experience]
```

**What You Configure:**

- Enable Session Tracking
- Enable Working Memory
- Set Scope: User-Scoped
- Add User ID: `{{ $json.studentId }}`

## Setting Up Working Memory

### Step 1: Enable Session Tracking

In your **Postgres Memory+** node:

```
Options → Session Tracking: ✅ Enable
Options → Sessions Table Name: n8n_chat_sessions
```

This creates a table to track conversations.

### Step 2: Add User Identification (Optional but Recommended)

```
Options → User ID: {{ $json.userId }}
```

This links conversations to specific users.

### Step 3: Enable Working Memory

```
Options → Working Memory: ✅ Enable
Options → Working Memory Scope: Choose one:
  - Thread-Scoped (separate memory per conversation)
  - User-Scoped (shared memory across all user conversations)
```

### Step 4: Customize the Template

Define what information you want to track:

```json
{
	"name": "",
	"email": "",
	"location": "",
	"preferences": {},
	"goals": [],
	"interests": []
}
```

The assistant will fill this in as users share information.

### Step 5: Add the Working Memory Tool

**Important:** You must manually add the Working Memory Tool node!

1. Drag **"Working Memory Tool"** onto your canvas
2. Connect it to your **AI Agent** as a tool input
3. Configure:
   - User ID: `{{ $json.userId }}`
   - Working Memory Scope: Match your Memory+ node setting
   - Same database credentials

## How the Assistant Uses Memory

### Automatic Updates

When users share information, the assistant automatically updates working memory:

```
User: "My name is Sarah and I prefer dark mode"

[Assistant thinks: "I should remember this"]
[Calls Working Memory Tool]

Working Memory Updated:
{
  "name": "Sarah",
  "preferences": {
    "theme": "dark"
  }
}
```

### Always Available Context

The assistant sees working memory at the start of every conversation:

```
[System Context Provided to Assistant]

WORKING_MEMORY: Persistent user information

Current Memory:
{
  "name": "Sarah",
  "location": "New York",
  "preferences": {"theme": "dark", "timezone": "EST"}
}

[User's new message]
User: "What time is it?"

[Assistant responds with context]
Assistant: "It's 3:00 PM EST in New York, Sarah!"
```

### Extensible Schema

The assistant can add new fields as it learns more:

```
Initial Template:
{
  "name": "",
  "location": ""
}

After Conversations:
{
  "name": "Sarah",
  "location": "New York",
  "occupation": "Software Developer",  // Added by assistant
  "interests": ["AI", "Photography"],  // Added by assistant
  "timezone": "EST"                    // Added by assistant
}
```

## Choosing the Right Scope

### When to Use Thread-Scoped Memory

**Perfect For:**

- Project management (separate contexts per project)
- Topic-specific discussions (work vs personal)
- Isolated customer support tickets
- Multi-purpose assistants handling different subjects

**Example Scenario:**

```
User has two conversations:
1. Planning a work presentation
2. Planning a personal vacation

Each conversation needs different context and shouldn't mix.
```

### When to Use User-Scoped Memory

**Perfect For:**

- Personal assistants (remember user everywhere)
- Customer service (persistent customer profiles)
- Educational platforms (track student progress)
- Healthcare (patient information across appointments)

**Example Scenario:**

```
User interacts with assistant across multiple sessions:
1. Morning: "Schedule my workout"
2. Afternoon: "What's on my calendar?"
3. Evening: "Remind me about tomorrow"

All sessions should know user's name, preferences, and context.
```

## Performance Considerations

### Thread-Scoped Memory

- **Storage**: One memory entry per conversation
- **Updates**: Fast (single row update)
- **Scaling**: Linear with number of conversations

### User-Scoped Memory

- **Storage**: One memory entry per user (regardless of conversation count)
- **Updates**: Fast (single row update in dedicated table)
- **Scaling**: Linear with number of users (not conversations!)

**Example:**

```
User with 50 active conversations:
- Thread-Scoped: 50 memory entries
- User-Scoped: 1 memory entry (much more efficient!)
```

## Best Practices

### 1. Design Your Template Thoughtfully

**Good Template:**

```json
{
	"name": "",
	"location": "",
	"preferences": {},
	"goals": []
}
```

**Why It's Good:**

- Clear structure
- Room for growth
- Organized by category

### 2. Use User IDs Consistently

**Good Practice:**

```javascript
// Always use the same user identifier
{
  "userId": "user-12345",
  "sessionId": "session-abc"
}
```

**Why It Matters:**

- Ensures memory follows the right user
- Prevents mixing user data
- Enables proper scoping

### 3. Choose Scope Based on Use Case

**Decision Matrix:**

| Your App Type        | Recommended Scope | Why                                    |
| -------------------- | ----------------- | -------------------------------------- |
| Personal Assistant   | User-Scoped       | User context should persist everywhere |
| Customer Service     | User-Scoped       | Customer history is crucial            |
| Project Management   | Thread-Scoped     | Projects need separate contexts        |
| Educational Platform | User-Scoped       | Student progress should persist        |
| Multi-topic Chat     | Thread-Scoped     | Topics shouldn't mix                   |

### 4. Start Simple, Expand Later

**Phase 1: Basic Memory**

```json
{
	"name": "",
	"location": ""
}
```

**Phase 2: Add More Fields**

```json
{
	"name": "",
	"location": "",
	"preferences": {},
	"goals": []
}
```

**Phase 3: Let Assistant Extend**

```json
{
	"name": "Sarah",
	"location": "New York",
	"preferences": { "theme": "dark" },
	"goals": ["Learn Spanish"],
	"timezone": "EST", // Added by assistant
	"occupation": "Developer" // Added by assistant
}
```

## Common Patterns

### Pattern 1: Progressive Profiling

Build user profiles gradually over time:

```
Conversation 1:
User: "I'm Sarah"
Memory: {"name": "Sarah"}

Conversation 2:
User: "I live in New York"
Memory: {"name": "Sarah", "location": "New York"}

Conversation 3:
User: "I'm a developer"
Memory: {"name": "Sarah", "location": "New York", "occupation": "Developer"}
```

### Pattern 2: Preference Learning

Learn and remember user preferences:

```
User: "I prefer dark mode"
Memory: {"preferences": {"theme": "dark"}}

User: "Always use 24-hour time format"
Memory: {"preferences": {"theme": "dark", "timeFormat": "24h"}}

User: "I speak Spanish"
Memory: {"preferences": {"theme": "dark", "timeFormat": "24h", "language": "es"}}
```

### Pattern 3: Goal Tracking

Track user goals and progress:

```
User: "I want to learn Spanish"
Memory: {"goals": ["Learn Spanish"]}

User: "I also want to get fit"
Memory: {"goals": ["Learn Spanish", "Get fit"]}

Later:
Assistant: "How's your Spanish learning going?"
Assistant: "Ready for your workout today?"
```

## Troubleshooting

### "Assistant doesn't remember information"

**Check:**

1. ✅ Session Tracking is enabled
2. ✅ Working Memory is enabled
3. ✅ Working Memory Tool is connected to AI Agent
4. ✅ User ID is consistent across conversations (for user-scoped)
5. ✅ Same database credentials in both nodes

### "Memory not persisting across conversations"

**For User-Scoped Memory:**

1. ✅ Verify Working Memory Scope is set to "User-Scoped"
2. ✅ Check User ID is being passed: `{{ $json.userId }}`
3. ✅ Ensure User ID is the same across conversations
4. ✅ Verify both nodes have matching scope settings

### "Assistant adds fields but loses existing ones"

**This means the assistant is sending partial updates.**

**Fix:** Update the system instructions to emphasize:

- "Always send the COMPLETE JSON object"
- "Include ALL existing fields plus new ones"
- "Never send partial updates"

## Migration Guide

### Starting Without Working Memory

If you already have conversations without working memory:

**Step 1: Enable Features**

```
1. Enable Session Tracking
2. Enable Working Memory
3. Choose Scope
4. Add Working Memory Tool
```

**Step 2: Existing Conversations**

- New conversations will have working memory
- Existing conversations will start with empty memory
- Memory builds up as users interact

**No Data Loss:**

- Chat history remains intact
- Only working memory starts fresh

### Switching Scopes

**From Thread-Scoped to User-Scoped:**

1. Change scope setting in both nodes
2. Existing thread memories remain in sessions table
3. New user memories start in user memory table
4. No migration needed - both work independently

**From User-Scoped to Thread-Scoped:**

1. Change scope setting in both nodes
2. Existing user memories remain in user memory table
3. New thread memories start in sessions table
4. No data loss - just different storage location

## Advanced Use Cases

### Multi-Tenant Applications

**Scenario:** SaaS platform with multiple organizations

```javascript
// Organization-scoped memory
{
  "userId": "org-123_user-456",
  "scope": "user"
}

// Each organization's users have separate memory
Org A - User 1: {name: "Alice", role: "Admin"}
Org B - User 1: {name: "Bob", role: "User"}
```

### Hybrid Approach

**Scenario:** Personal assistant with project-specific contexts

```javascript
// User-scoped for personal info
User Memory: {
  name: "Sarah",
  location: "New York",
  preferences: {theme: "dark"}
}

// Thread-scoped for project contexts
Project A Thread: {project: "Website", deadline: "March 15"}
Project B Thread: {project: "Mobile App", deadline: "April 1"}
```

**Implementation:**

- Use user-scoped memory for personal information
- Use thread-scoped conversations for project-specific context
- Best of both worlds!

### Contextual Assistants

**Scenario:** Assistant that adapts to user's current activity

```json
{
	"name": "Sarah",
	"currentActivity": "Working on presentation",
	"workingHours": "9am-5pm EST",
	"doNotDisturb": false,
	"activeProjects": ["Q1 Report", "Team Meeting Prep"]
}
```

**Assistant Behavior:**

- During work hours: Professional tone, focus on work tasks
- After hours: Casual tone, personal topics
- DND mode: Only urgent notifications

## Tips for Success

### 1. Start with Essential Information

Don't try to track everything at once:

```json
// Good: Start simple
{
  "name": "",
  "location": ""
}

// Too much: Overwhelming template
{
  "name": "", "email": "", "phone": "", "address": "",
  "birthday": "", "occupation": "", "company": "",
  "interests": [], "hobbies": [], "goals": [],
  "preferences": {}, "settings": {}, "history": []
}
```

### 2. Let Memory Grow Naturally

The assistant will add fields as needed:

```json
// Week 1
{"name": "Sarah", "location": "New York"}

// Week 2
{"name": "Sarah", "location": "New York", "occupation": "Developer"}

// Week 3
{"name": "Sarah", "location": "New York", "occupation": "Developer",
 "interests": ["AI", "Photography"], "timezone": "EST"}
```

### 3. Test with Real Conversations

Try these scenarios:

- User shares information gradually
- User returns after days/weeks
- User has multiple concurrent conversations
- User updates their information

### 4. Monitor Memory Growth

Check what the assistant is storing:

```sql
-- View user memories
SELECT user_id, working_memory
FROM n8n_chat_sessions_user_memory
ORDER BY updated_at DESC
LIMIT 10;

-- View thread memories
SELECT id, working_memory
FROM n8n_chat_sessions
WHERE working_memory IS NOT NULL
ORDER BY updated_at DESC
LIMIT 10;
```

## Summary

### What You Get

✅ **Personalized Experience**: Users feel recognized and understood  
✅ **Reduced Friction**: No repetitive questions  
✅ **Better Context**: Assistant makes smarter decisions  
✅ **User Satisfaction**: Feels like talking to someone who knows you  
✅ **Scalable**: Handles thousands of users efficiently

### What You Need

1. **Postgres Memory+ Node**: Main memory system
2. **Working Memory Tool Node**: Memory update mechanism
3. **User ID**: Consistent user identification (for user-scoped)
4. **Template**: Structure for information to track

### Quick Start Checklist

- [ ] Enable Session Tracking in Postgres Memory+ node
- [ ] Add User ID field: `{{ $json.userId }}`
- [ ] Enable Working Memory
- [ ] Choose scope (thread or user)
- [ ] Customize memory template
- [ ] Add Working Memory Tool node to workflow
- [ ] Connect tool to AI Agent
- [ ] Match settings between both nodes
- [ ] Test with sample conversations

---

**Ready to build assistants that truly remember your users!**
