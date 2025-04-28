# pan-agent

A universal JavaScript module for connecting to the [PAN](https://gitlab.com/jk0ne/pan-node) (Peer Application Network) via browser or Node.js. Acts as your "agent" on the network — allowing you to join groups, send and receive messages, and interact with other agents in real-time.

## ✨ Features

- Connect to a PAN node from browser or Node.js
- Join and interact with message groups
- Send direct messages to other peers
- Use UUIDv5-based deterministic IDs for groups and message types
- Fully ESM-compatible (with CommonJS loader for Node)

## 🚀 Install

```bash
npm install pan-agent
```

## 🧠 Concepts

- **PAN Node**: A router/server on the PAN network
- **Agent**: Your app's representative — connects, joins groups, sends/receives messages
- **Group**: A virtual channel identified by a UUIDv5 key
- **Message Type**: Namespaced string used to route messages inside groups

## 🧪 Usage

### ➤ ESM (browser or `"type": "module"` Node)

```js
import { PanAgent } from 'pan-agent';

const agent = new PanAgent({
  url: 'ws://localhost:5295',
  token: 'your.jwt.token',
  appId: 'your-app-id-uuid'
});

await agent.connect();

const groupId = agent.getGroupId('chatroom', 'shared-key');
const group = agent.joinGroup(groupId, ['chat.text']);

group.on('chat.text', msg => {
  console.log('Message received:', msg.payload);
});

group.send('chat.text', { text: 'Hello world!' });
```

### ➤ CommonJS (`require()`)

```js
const { loadPanAgent } = require('pan-agent');

(async () => {
  const { PanAgent } = await loadPanAgent();

  const agent = new PanAgent({
    url: 'ws://localhost:5295',
    token: 'your.jwt.token',
    appId: 'your-app-id-uuid'
  });

  await agent.connect();
})();
```

## 📚 API

### class `PanAgent`

- `constructor({ url, token, appId, ttl = 8 })`
- `connect(): Promise<void>`
- `getGroupId(groupName, key?): string`  
- `getMessageType(type, namespace?): string`
- `joinGroup(groupId, msgTypes = []): PanGroup`
- `sendDirect(nodeId, connId, msgType, payload)`

### class `PanGroup`

- `on(msgType, handlerFn)`
- `send(msgType, payload): msgId`

## 🌍 Works Everywhere

✅ Node 16+  
✅ Modern browsers (via `<script type="module">`)  
✅ Fully portable — uses native WebSocket or polyfills `ws` in Node

## 📄 License

LGPL-2.1-or-later
