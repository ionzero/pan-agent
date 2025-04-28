import { uuidv4, uuidv5 } from './uuid.mjs';

// Shim WebSocket in Node if needed
if (typeof WebSocket === 'undefined') {
    globalThis.WebSocket = (await import('ws')).default;
}

const NULL_ID = '00000000-0000-0000-0000-000000000000';

export class PanAgent {
    constructor({ url, token, appId, ttl = 8 }) {
        this.url = url;
        this.token = token;
        this.appId = appId;
        this.ttl = ttl;
        this.nodeId = NULL_ID;
        this.connId = NULL_ID;

        this.socket = null;
        this.connected = false;
        this.groups = new Map(); // Map<groupId, PanGroup>
        this.pendingJoins = new Map(); // Map<groupId, PanGroup>
        this.eventListeners = new Map(); // Map<eventName, Array<{ fn, once }>>
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);

            this.socket.addEventListener('open', () => {
                const authMsg = {
                    msg_id: uuidv4(),
                    type: 'control',
                    msg_type: 'auth',
                    from: {
                        node_id: NULL_ID,
                        conn_id: NULL_ID,
                    },
                    payload: {
                        auth_type: 'standard',
                        token: this.token,
                    },
                };
                this._sendRaw(authMsg);
            });

            this.socket.addEventListener('message', (event) => {
                const msg = JSON.parse(event.data);
                this._dispatchIncomingMessage(msg);
            });

            this.once('connected', (payload) => {
                this.connected = true;
                this.connId = payload.conn_id;
                this.nodeId = payload.node_id;
                this.authKey = payload.auth_key;
                resolve();
            });
            this.once('auth_failed', reject);

            this.socket.addEventListener('error', reject);

            this.socket.addEventListener('close', () => {
                this.connected = false;
                this._emit('disconnected');
            });
        });
    }
    async disconnect() {
        this.socket.close();
    }

    async reconnect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.close();
        }

        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);

            this.socket.addEventListener('open', () => {
                // TODO: add reconnect support (auth_key, etc.)
                const authMsg = {
                    type: 'control',
                    msg_type: 'auth',
                    from: {
                        node_id: NULL_ID,
                        conn_id: NULL_ID,
                    },
                    payload: {
                        token: this.token,
                        auth_type: 'reconnect',
                        reconnect:  {
                            conn_id: this.connId,
                            auth_key: this.authKey,
                        },
                    },
                    msg_id: uuidv4(),
                };
                this._sendRaw(authMsg);
            });

            this.socket.addEventListener('message', (event) => {
                const msg = JSON.parse(event.data);
                this._dispatchIncomingMessage(msg);
            });

            this.once('connected', async () => {
                for (const group of this.groups.values()) {
                    await group._rejoin();
                }
                resolve();
            });

            this.socket.addEventListener('error', reject);

            this.socket.addEventListener('close', () => {
                this.connected = false;
                this._emit('disconnected');
            });
        });
    }

    _dispatchIncomingMessage(msg) {
        this._emit('msg', msg);

        if (msg.type === 'control') {
            if (msg.msg_type === 'auth.ok' && msg.payload) {
                this._emit('connected', msg.payload);
            }
            if (msg.msg_type === 'auth.failed') {
                this._emit('auth_failed', msg.payload);
      	    }
	    if (msg.msg_type === 'join_group_reply' && msg.in_response_to) {
		const pending = this.pendingJoins.get(msg.in_response_to);
		if (pending) {
		    pending.completer(msg);
		}
		return;
	    }
            this._emit('control', msg);
        } else if (msg.type === 'direct') {
            this._emit('direct', msg);
        } else if (msg.type === 'broadcast') {
            const group = this.groups.get(msg.group);
            if (group) {
                group._emit(msg.msg_type, msg);
            } else {
                console.warn(`Received broadcast for unknown group: ${msg.group}`);
            }
            this._emit('broadcast', msg);
        }
    }

    _emit(eventName, payload) {
        const listeners = this.eventListeners.get(eventName);
        if (listeners) {
            for (const { fn, once } of [...listeners]) {
                setTimeout(() => fn(payload), 0);
                if (once) {
                    this._removeListenerInternal(eventName, fn);
                }
            }
        }
    }

    on(eventName, fn) {
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push({ fn, once: false });
    }

    once(eventName, fn) {
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push({ fn, once: true });
    }

    removeListener(eventName, fn) {
        this._removeListenerInternal(eventName, fn);
    }

    removeAllListeners(eventName) {
        this.eventListeners.delete(eventName);
    }

    _removeListenerInternal(eventName, fn) {
        const listeners = this.eventListeners.get(eventName);
        if (!listeners) return;
        const idx = listeners.findIndex(l => l.fn === fn);
        if (idx !== -1) {
            listeners.splice(idx, 1);
        }
        if (listeners.length === 0) {
            this.eventListeners.delete(eventName);
        }
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

    async joinGroup(groupId, msgTypeHandlers) {
	if (typeof msgTypeHandlers !== 'object' || msgTypeHandlers === null) {
	    throw new Error('joinGroup requires a msgTypeHandlers object');
	}

	const msgId = uuidv4();

	const joinMsg = {
	    msg_id: msgId,
	    type: 'control',
	    msg_type: 'join_group',
	    payload: { 
		group: groupId,
	    	msg_types: Object.keys(msgTypeHandlers)
	    },
	};

	return new Promise((resolve, reject) => {
	    const timeout = setTimeout(() => {
		this.pendingJoins.delete(msgId);
		reject(new Error('join_group_reply timeout'));
	    }, 3000);

	    this.pendingJoins.set(msgId, {
		completer: (replyMsg) => {
		    clearTimeout(timeout);
		    this.pendingJoins.delete(msgId);

		    if (replyMsg.payload.status === 'ok') {
			const group = new PanGroup(groupId, this);
			for (const [msgType, handler] of Object.entries(msgTypeHandlers)) {
			    if (typeof handler !== 'function') {
				throw new Error(`Missing handler function for message type "${msgType}"`);
			    }
			    group.setHandler(msgType, handler);
			}
			this.groups.set(groupId, group);
			resolve(group);
		    } else {
			reject(new Error(replyMsg.payload.error || 'join_group failed'));
		    }
		}
	    });

	    this._sendRaw(joinMsg);
	});
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
        // we're going to assume if you set msg.from yourself, 
        // you know what you're doing and accept the consequences.
        if (typeof msg.from != 'object') {
            msg.from = {
                node_id: this.nodeId,
                conn_id: this.connId
            };
        }
        this.socket.send(JSON.stringify(msg));
    }
}

export class PanGroup {
    constructor(groupId, agent) {
        this.groupId = groupId;
        this.agent = agent;
        this.listeners = new Map(); // Map<msg_type, Array<fn>>
    }

    setHandler(msgType, fn) {
        if (!this.listeners.has(msgType)) {
            this.listeners.set(msgType, []);
        }
        this.listeners.get(msgType).push(fn);
    }

    removeHandler(msgType, fn) {
        const handlers = this.listeners.get(msgType);
        if (!handlers) return;
        const idx = handlers.indexOf(fn);
        if (idx !== -1) {
            handlers.splice(idx, 1);
        }
        if (handlers.length === 0) {
            this.listeners.delete(msgType);
        }
    }

    removeAllHandlers(msgType) {
        this.listeners.delete(msgType);
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

    async _rejoin() {
        if (!this.agent.connected) return;

        const msgId = uuidv4();
        const joinMsg = {
            type: 'control',
            msg_type: 'join_group',
	    payload: { 
		group: this.groupId,
            	msg_types: [...this.listeners.keys()],
	    },
            msg_id: msgId,
        };

        this.agent._sendRaw(joinMsg);
    }

    _emit(msgType, msg) {
        const handlers = this.listeners.get(msgType) || [];
        for (const fn of [...handlers]) {
            setTimeout(() => fn(msg), 0);
        }
    }
}
