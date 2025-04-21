
import { uuidv4, uuidv5 } from './uuid.mjs';
// shim WebSocket in Node
if (typeof WebSocket === 'undefined') {
   globalThis.WebSocket = (await import('ws')).default;
}


export class PanAgent {
    constructor({ url, token, appId, ttl = 8 }) {
        this.url = url;
        this.token = token;
        this.appId = appId;
        this.ttl = ttl;

        this.socket = null;
        this.connected = false;
        this.groups = new Map();
        this._pending = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);

            this.socket.addEventListener('open', () => {
                const authMsg = {
                    type: 'control',
                    msg_type: 'auth',
                    token: this.token,
                    msg_id: uuidv4(),
                };
                this._sendRaw(authMsg);
            });

            this.socket.addEventListener('message', (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'control' && msg.msg_type === 'auth.ok') {
                    this.connected = true;
                    this.connId = msg.payload.conn_id;
                    resolve();
                } else if (msg.type === 'broadcast') {
                    const group = this.groups.get(msg.group);
                    if (group) group._emit(msg.msg_type, msg);
                } else if (msg.type === 'direct') {
                    this._emit?.('direct:' + msg.msg_type, msg);
                }
            });

            this.socket.addEventListener('error', reject);
            this.socket.addEventListener('close', () => {
                this.connected = false;
            });
        });
    }

    getGroupId(groupName, key) {
        let groupString = groupName.trim();
        if (typeof key === 'string') {
            groupString = key.trim() + ':' + groupName.trim();
        }
        return uuidv5(groupString, this.appId);
    }

    getMessageType(type, namespace) {
        if (typeof namespace === 'string') {
            const typeString = namespace.trim() + ':' + type.trim();
            return uuidv5(typeString, this.appId);
        } else {
            return type.trim();
        }
    }

    joinGroup(groupId, msgTypes = []) {
        const msgId = uuidv4();
        const joinMsg = {
            type: 'control',
            msg_type: 'join_group',
            group: groupId,
            msg_id: msgId,
            msg_types: msgTypes,
        };

        const group = new PanGroup(groupId, this);
        this.groups.set(groupId, group);
        this._sendRaw(joinMsg);
        return group;
    }

    sendDirect(nodeId, connId, msgType, payload) {
        const msg = {
            type: 'direct',
            msg_id: uuidv4(),
            to: { node_id: nodeId, conn_id: connId },
            msg_type: msgType,
            payload,
            ttl: this.ttl,
        };
        this._sendRaw(msg);
    }

    _sendRaw(msg) {
        msg.ttl ??= this.ttl;
        if (!msg.msg_id) msg.msg_id = uuidv4();
        this.socket.send(JSON.stringify(msg));
    }
}

export class PanGroup {
    constructor(groupId, agent) {
        this.groupId = groupId;
        this.agent = agent;
        this.listeners = new Map();
    }

    on(msgType, fn) {
        if (!this.listeners.has(msgType)) {
            this.listeners.set(msgType, []);
        }
        this.listeners.get(msgType).push(fn);
    }

    send(msgType, payload) {
        const msg = {
            type: 'broadcast',
            group: this.groupId,
            msg_type: msgType,
            payload,
            msg_id: uuidv4(),
        };
        this.agent._sendRaw(msg);
        return msg.msg_id;
    }

    _emit(type, msg) {
        const handlers = this.listeners.get(type) || [];
        for (const fn of handlers) fn(msg);
    }
}
