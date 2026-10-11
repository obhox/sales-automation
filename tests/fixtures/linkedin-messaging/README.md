# LinkedIn messaging fixtures

What LinkedIn's messaging endpoints return, for the inbox reader's tests.

The **shape** (field names, nesting, which fields are null) is LinkedIn's, as captured
from a signed-in account on 2026-10-10. **Every value is invented**: the people, the ids,
the times and the words. No real conversation is stored in this repository, and the
captures the shape was copied from were never committed.

- `conversations.json`: the conversation list a signed-in page loads (`messengerConversations`).
  One of each kind the reader has to tell apart: a sponsored message, a contact whose last
  message is theirs, one whose last message is the account owner's, a company page, a
  group chat, a stranger, and a message with an attachment and no text.
- `thread.json`: one conversation's messages (`messengerMessages`), newest first.
