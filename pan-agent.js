// pan-agent.mjs
//
// PAN Agent client for PAN access points (nodes).
//
// Implements the finalized spec:
//   - Clean async interface: connect(), authenticate(), join_group(), leave_group()
//   - GroupHandle abstraction with .send(), .on(), .off(), .leave()
//   - No in_response_to or pending reply logic; all correlation handled by server semantics
//   - join/leave promises keyed by group_id (UUID)
//   - Namespace-based UUIDv5 mapping
//   - Adjustable TTL after auth, forced TTL=1 pre-auth
//   - Byte/message stats
//   - EventEmitter interface for lifecycle + message events
//

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import crypto from "node:crypto";
import { v5 as uuidv5, validate as isUuid } from "uuid";

export const NULL_ID = "00000000-0000-0000-0000-000000000000";

/** Generate UUIDv5 or return existing UUID */
function toUuid(str, namespace) {
    if (!str) throw new Error("toUuid: empty string");
    if (isUuid(str)) return str;
    return uuidv5(str, namespace);
}

function nowMs() {
    return Date.now();
}

/** GroupHandle helper */
class GroupHandle {
    constructor(agent, groupId) {
        this.agent = agent;
        this.id = groupId;
        this.handlers = new Map();
    }

    async send(msgType, payload, opts = {}) {
        return this.agent.send_group(this.id, msgType, payload, opts);
    }

    on(msgType, handler) {
        const typeId = this.agent.get_message_type(msgType);
        this.handlers.set(typeId, handler);
        return this;
    }

    off(msgType) {
        const typeId = this.agent.get_message_type(msgType);
        this.handlers.delete(typeId);
        return this;
    }

    async leave() {
        return this.agent.leave_group(this.id);
    }

    _dispatch(msg) {
        const fn = this.handlers.get(msg.msg_type);
        if (fn) fn(msg.payload, msg);
    }
}

/** PanAgent main class */
export default class PanAgent extends EventEmitter {
    constructor(opts = {}) {
        super();

        if (!opts.url) throw new Error("PanAgent requires url");
        if (!opts.app_id) throw new Error("PanAgent requires app_id");

        this.url = opts.url;
        this.app_id = opts.app_id;
        this.namespace = opts.namespace || this.app_id;

        this.default_ttl = opts.default_ttl ?? 8;
        this.max_ttl = opts.max_ttl ?? 32;
        this.request_timeout = opts.request_timeout_ms ?? 10000;
        this.debug = !!opts.debug;

        // Internal state
        this.state = "DISCONNECTED";
        this.ws = null;

        // Identity
        this.node_id = NULL_ID;
        this.conn_id = NULL_ID;

        // Stats
        this.stats = {
            connected_at: null,
            authenticated_at: null,
            bytes_in: 0,
            bytes_out: 0,
            msgs_in_total: 0,
            msgs_out_total: 0,
            msgs_in_by_type: { direct: 0, group: 0, control: 0, unknown: 0 },
            msgs_out_by_type: { direct: 0, group: 0, control: 0, unknown: 0 },
        };

        // Groups
        this.groups = new Map(); // groupId -> GroupHandle
        this.pendingJoins = new Map(); // groupId -> {resolve,reject,timeout}
        this.pendingLeaves = new Map();

        this._shouldRun = true;
    }

    _log(...a) {
        if (this.debug) console.log("[PanAgent]", ...a);
    }

    /** Utility for app developers */
    get_group_id(str, ns) {
        return toUuid(str, ns || this.namespace);
    }

    get_message_type(str, ns) {
        return toUuid(str, ns || this.namespace);
    }

    /** Stats getter (deep copy) */
    get_stats() {
        return JSON.parse(JSON.stringify(this.stats));
    }

    /** Connect and perform HELO */
    async connect() {
        if (this.state !== "DISCONNECTED") throw new Error("connect() invalid state");
        this.state = "CONNECTING";

        this.ws = new WebSocket(this.url);
        this.ws.binaryType = "arraybuffer";

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 8000);
            this.ws.once("open", () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.once("error", reject);
        });

        this._bindSocket();

        // Send helo
        const msg = this._makeControl("helo", {});
        this._sendRaw(msg, 1);

        // Wait for helo control reply
        const heloMsg = await this._waitForControl("helo", this.request_timeout);
        this.emit("helo", heloMsg);
        this.state = "CONNECTED_UNTRUSTED";
        this.stats.connected_at = nowMs();
        return heloMsg;
    }

    /** Authenticate after helo */
    async authenticate({ token, tokens }) {
        if (this.state !== "CONNECTED_UNTRUSTED") throw new Error("Not ready to authenticate");

        const msg = this._makeControl("auth", { token, tokens });
        this._sendRaw(msg, 1);
        this.state = "AUTHENTICATING";

        const reply = await this._waitForControl(["auth.ok", "auth.failed"], this.request_timeout);
        if (reply.msg_type === "auth.failed") {
            this.emit("auth_failed", reply);
            this.state = "CONNECTED_UNTRUSTED";
            throw new Error("Authentication failed");
        }

        const p = reply.payload || {};
        this.node_id = p.node_id || NULL_ID;
        this.conn_id = p.conn_id || NULL_ID;

        this.state = "AUTHENTICATED";
        this.stats.authenticated_at = nowMs();
        this.emit("authenticated", p);
        return p;
    }

    /** Join group */
    async join_group(groupId, msgHandlers = {}) {
        if (this.state !== "AUTHENTICATED") throw new Error("join_group requires authenticated");

        const gId = this.get_group_id(groupId);
        const group = this.groups.get(gId) || new GroupHandle(this, gId);
        this.groups.set(gId, group);

        for (const [key, fn] of Object.entries(msgHandlers)) {
            const mId = this.get_message_type(key);
            group.on(mId, fn);
        }

        const msg_types = Array.from(group.handlers.keys());
        const msg = this._makeControl("join_group", { group: gId, msg_types });
        this._sendRaw(msg);

        const promise = new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this.pendingJoins.delete(gId);
                reject(new Error("join_group timeout"));
            }, this.request_timeout);
            this.pendingJoins.set(gId, { resolve, reject, t });
        });

        return promise;
    }

    /** Leave group */
    async leave_group(groupId) {
        const gId = this.get_group_id(groupId);
        const msg = this._makeControl("leave_group", { group: gId });
        this._sendRaw(msg);

        const promise = new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this.pendingLeaves.delete(gId);
                reject(new Error("leave_group timeout"));
            }, this.request_timeout);
            this.pendingLeaves.set(gId, { resolve, reject, t });
        });

        return promise;
    }

    /** Direct and group sends */
    send_direct(to, msgType, payload, opts = {}) {
        if (this.state !== "AUTHENTICATED") throw new Error("Not authenticated");
        const msg = {
            type: "direct",
            msg_type: this.get_message_type(msgType),
            to,
            payload,
        };
        this._sendRaw(msg, opts.ttl);
        return msg.msg_id;
    }

    send_group(groupId, msgType, payload, opts = {}) {
        if (this.state !== "AUTHENTICATED") throw new Error("Not authenticated");
        const msg = {
            type: "broadcast",
            group: this.get_group_id(groupId),
            msg_type: this.get_message_type(msgType),
            payload,
        };
        this._sendRaw(msg, opts.ttl);
        return msg.msg_id;
    }

    /** Close connection */
    close(code = 1000, reason = "client close") {
        this._shouldRun = false;
        if (this.ws) {
            try {
                this.ws.close(code, reason);
            } catch {}
        }
        this.ws = null;
        this.state = "DISCONNECTED";
        this.emit("disconnected", { code, reason });
    }

    // ------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------

    _makeControl(type, payload) {
        return {
            type: "control",
            msg_type: type,
            msg_id: crypto.randomUUID(),
            payload: payload || {},
            from: { node_id: this.node_id, conn_id: this.conn_id },
        };
    }

    _sendRaw(msg, ttl = this.default_ttl) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            throw new Error("WebSocket not open");

        const isAuth = this.state === "AUTHENTICATED";
        const effectiveTtl = isAuth
            ? Math.max(0, Math.min(this.max_ttl, ttl ?? this.default_ttl))
            : 1;

        msg.ttl = effectiveTtl;

        if (!msg.from) {
            msg.from = {
                node_id: isAuth ? this.node_id : NULL_ID,
                conn_id: isAuth ? this.conn_id : NULL_ID,
            };
        }

        if (!msg.msg_id) msg.msg_id = crypto.randomUUID();

        const raw = JSON.stringify(msg);
        this.stats.bytes_out += Buffer.byteLength(raw);
        this.stats.msgs_out_total++;
        const t = msg.type || "unknown";
        this.stats.msgs_out_by_type[t] = (this.stats.msgs_out_by_type[t] || 0) + 1;

        this.ws.send(raw);
    }

    _bindSocket() {
        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.stats.bytes_in += data.length;
                this.stats.msgs_in_total++;
                const t = msg.type || "unknown";
                this.stats.msgs_in_by_type[t] =
                    (this.stats.msgs_in_by_type[t] || 0) + 1;
                this._dispatch(msg);
            } catch (e) {
                this._log("Bad JSON", e);
            }
        });

        this.ws.on("close", (c, r) => {
            this._log("WS close", c, r.toString());
            this.state = "DISCONNECTED";
            this.emit("disconnected", { code: c, reason: r.toString() });
        });

        this.ws.on("error", (e) => {
            this._log("WS error", e.message);
            this.emit("error", e);
        });
    }

    async _waitForControl(types, timeout) {
        if (!Array.isArray(types)) types = [types];
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener("control", onCtrl);
                reject(new Error("timeout waiting for control " + types.join(",")));
            }, timeout);

            const onCtrl = (msg) => {
                if (types.includes(msg.msg_type)) {
                    clearTimeout(timer);
                    this.removeListener("control", onCtrl);
                    resolve(msg);
                }
            };

            this.on("control", onCtrl);
        });
    }

    _dispatch(msg) {
        if (msg.type === "control") {
            this._handleControl(msg);
            return;
        }
        if (msg.type === "direct") {
            this.emit("direct", msg);
            return;
        }
        if (msg.type === "broadcast") {
            const group = this.groups.get(msg.group);
            if (group) group._dispatch(msg);
            this.emit("group", msg);
            return;
        }
        this.emit("message", msg);
    }

    _handleControl(msg) {
        const t = msg.msg_type;
        this.emit("control", msg);

        if (t === "helo") return; // handled by _waitForControl

        if (t === "auth.ok" || t === "auth.failed") return; // handled by _waitForControl

        if (t === "join_group_reply") {
            const g = msg.payload?.group;
            const p = this.pendingJoins.get(g);
            if (p) {
                clearTimeout(p.t);
                this.pendingJoins.delete(g);
                if (msg.payload?.status === "ok") {
                    this.emit("group.joined", { group: g });
                    p.resolve(this.groups.get(g));
                } else {
                    p.reject(new Error("join_group failed"));
                }
            }
            return;
        }

        if (t === "leave_group_reply") {
            const g = msg.payload?.group;
            const p = this.pendingLeaves.get(g);
            if (p) {
                clearTimeout(p.t);
                this.pendingLeaves.delete(g);
                if (msg.payload?.status === "ok") {
                    this.emit("group.left", { group: g });
                    p.resolve(true);
                } else {
                    p.reject(new Error("leave_group failed"));
                }
            }
            return;
        }
    }
}
