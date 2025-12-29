# PAN Agent Client

PAN (Peer Application Network) is a lightweight, user-centric way to build peer-to-peer applications without a smart central server.

A PAN-based application is **not a service you deploy**.  
It’s a **class of compatible agents** that connect to the PAN network and talk to each other directly.

If you can connect to a PAN node, your app can participate.

---

## Mental Model

### The simplest way to think about PAN

- A **PAN node** is like a Wi-Fi access point.
- A **PAN agent** is like a laptop or phone connecting to it.
- A **PAN app** is a type of software that multiple agents run.
- A **PAN group** is a shared communication channel.
- **Message types** define what kinds of messages agents care about.

There is no “main server” coordinating logic.

Agents connect to any PAN node, join groups, and exchange messages.  
The intelligence lives **in the agents**, not the network.

---

## What is a PAN app?

A PAN app is defined by:

1. An **app_id** (a UUID)
2. A set of **groups** the app uses
3. A set of **message types** the app understands
4. Application logic that reacts to messages

All agents with the same `app_id` can interoperate.

Multiple independent implementations can exist for the same app_id.

---

## What is an agent?

An **agent** is a running instance of your app.

Each agent:
- connects to a PAN node (an access point)
- authenticates using its own identity
- joins one or more groups
- sends and receives messages

A working PAN app is simply **multiple agents running and talking**.

No central coordination required.

---

## Groups

A **group** is a named communication channel.

Examples:
- `"global-chat"`
- `"room:engineering"`
- `"event:1234"`

Under the hood, group names are converted to UUIDs using UUIDv5.  
This prevents collisions while keeping development easy.

All agents that join the same group can exchange messages.

---

## Message Types

Messages always have a **type**.

Examples:
- `"chat"`
- `"status"`
- `"typing"`
- `"presence"`

Like groups, message types are converted to UUIDs internally.

Agents subscribe to message types when joining a group, so the network only delivers messages they care about.

---

## Example: A Chat App

A minimal chat app might define:

- **Group**: `"chat-room"`
- **Message types**:
  - `"chat"` – user messages
  - `"status"` – online/offline/presence

Each agent:
1. Connects to a PAN node
2. Authenticates
3. Joins `"chat-room"`
4. Sends:
   - `{ type: "status", text: "online" }`
   - `{ type: "chat", text: "hello world" }`
5. Receives messages from other agents in the same group

That’s it.  
No message broker. No central database. No coordination service.

---

## PAN Agent Client

The `PanAgent` module is a **high-level client library** for building PAN apps.

It handles:
- connection lifecycle
- authentication
- group membership
- message routing
- UUID mapping
- TTL / message spread control

It does **not**:
- impose request/response semantics
- expose control-plane messages
- manage application-level protocols

Those are intentionally left to the app.

---

## Installation

```bash
npm install pan-agent vouchsafe ws
````

---

## Creating an Agent

```js
import PanAgent from "./pan-agent.mjs";

const agent = new PanAgent({
    url: "ws://localhost:5295",
    app_id: "9a2c2c88-6c5f-4e57-b0b1-0f7fd92e7c3c", // must be a UUID
    // namespace defaults to app_id
});
```

### app_id

* **Required**
* Must be a UUID
* Identifies the *type* of application
* Ensures compatible apps arrive in the same groups

### namespace

* Optional
* Defaults to `app_id`
* Used as the UUIDv5 namespace for group and message names
* Advanced apps may override this to create isolated sub-networks

---

## Connection Lifecycle

### connect()

```js
const helo = await agent.connect();
```

* Opens a WebSocket connection
* Sends a `helo` message
* Resolves with the server’s helo response
* The server proves its identity first

You decide whether to trust the server **before** revealing agent identity.

---

### authenticate()

```js
await agent.authenticate({ token });
```

* Sends authentication token (typically Vouchsafe)
* On success:

  * agent receives `node_id` and `conn_id`
  * agent enters authenticated state
* On failure:

  * promise rejects
  * agent remains untrusted

---

## Joining Groups

```js
const group = await agent.join_group("chat-room", {
    chat: (payload, msg) => {
        console.log("chat:", payload.text);
    },
    status: (payload, msg) => {
        console.log("status:", payload.text);
    }
});
```

* Group names can be strings or UUIDs
* Message types can be strings or UUIDs
* Strings are converted via UUIDv5(namespace)

You can call `join_group()` multiple times to add more message types.

---

## GroupHandle

`join_group()` returns a **GroupHandle**.

```js
group.send("chat", { text: "hello" });
group.on("chat", handler);
group.off("status");
await group.leave();
```

GroupHandle methods:

* `send(msg_type, payload, opts?)`
* `on(msg_type, handler)`
* `off(msg_type)`
* `leave()`

---

## Sending Messages

### Group message

```js
agent.send_group("chat-room", "chat", { text: "hello" });
```

### Direct message

```js
agent.send_direct(
    { node_id, conn_id },
    "ping",
    { time: Date.now() }
);
```

---

## TTL (Message Spread)

TTL controls how far messages propagate across the PAN network.

* During connect/auth: TTL is forced to `1`
* After authentication:

  * default TTL is configurable
  * per-message TTL can be overridden
  * TTL is clamped to a maximum

```js
agent.send_group("chat-room", "chat", { text: "hi" }, { ttl: 4 });
```

Lower TTL = tighter scope
Higher TTL = wider reach

---

## Events

Agents emit high-level events only.

```js
agent.on("helo", msg => {});
agent.on("authenticated", info => {});
agent.on("auth_failed", info => {});
agent.on("disconnected", info => {});
agent.on("direct", msg => {});
agent.on("group", msg => {});
agent.on("error", err => {});
```

---

## Stats

```js
const stats = agent.get_stats();
```

Includes:

* bytes in / out
* message counts
* connection timestamps

---

## Design Philosophy

PAN is intentionally:

* **Decentralized**
* **Infrastructure-light**
* **User-centric**
* **Application-driven**

You don’t deploy a backend and wait for users.

You publish an app, and agents connect wherever they can.

The network just moves messages.

---

## Summary

If you know how to:

* open a socket
* join a channel
* send messages

You already know how to build PAN apps.

PAN removes everything else.

---

Happy hacking.

