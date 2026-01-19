// pan-agent.mjs
//
// PAN Agent client for PAN access points (nodes).
//
// Implements the finalized spec:
//   - Clean async interface: connect(), authenticate(), join_group(), leave_group()
//   - PanGroup abstraction with .send(), .on(), .off(), .leave()
//   - No in_response_to or pending reply logic; all correlation handled by server semantics
//   - join/leave promises keyed by group_id (UUID)
//   - Namespace-based UUIDv5 mapping
//   - Adjustable TTL after auth, forced TTL=1 pre-auth
//   - Byte/message stats
//   - EventEmitter interface for lifecycle + message events
//

import WebSocket from "ws";
import crypto from "crypto";
import { v5 as uuidv5, validate as isUuid } from "uuid";
import { 
    PAN_ENCODING_BINARY,
    PAN_ENCODING_JSON,
    MAX_PAYLOAD_SIZE, 
    MAX_JSON_ENVELOPE_SIZE, 
    ROUTING_ENVELOPE_SIZE, 
    NULL_ID,
    validateMessageFromAgent, 
    validateMessageToAgent,
    encodePacket, 
    decodePacket,
} from '@ionzero/pan-util';
import { attachDispatcher } from '@ionzero/dispatcher';

function nowMs() {
    return Date.now();
}

function get_uuid_for(str, namespace) {
   if (isUuid(namespace)) {
        return uuidv5(str, namespace); 
    } else if (!isUuid(str)) {
        return uuidv5(str, this.namespace);
    } else {
        return str;
    }
}

/** PanGroup */
export class PanGroup {

    // namespace can not be changed after construction.
    #namespace
    // id can not be changed after construction
    #id

    constructor(options) { 
        attachDispatcher(this);
        if (! options.agent instanceof PanAgent) {
            throw new Error('Invalid agent provided');
        }
        if (!isUuid(options.namespace)) {
            throw new Error('Invalid namespace! group namespace is required');
        }
        if (!options.name) {
            throw new Error('A group name is required');
        }
        this.active = false;
        this.agent = options.agent;
        this.#namespace = options.namespace;
        this.name = options.name;
        this.message_types = new Map();

        // if we are given a group uuid, we use it as is.
        // if we are given something else, we create a uuidv5 with our namespace
        if (isUuid(options.id)) {
            this.#id = options.id;
        } else {
            this.#id = get_uuid_for(options.name, this.#namespace); 
        }
    }

    get_id() {
        return this.#id;
    }

    send(message_type, payload, opts = {}) {
        let message_type_id = message_type;
        if (!isUuid(message_type)) {
            message_type_id = get_uuid_for(message_type, this.#namespace); 
        }
        
        const msg = {
            type: "broadcast",
            spread: opts.spread || opts.ttl,
            ttl: opts.ttl, // if ttl is not defined, the agent will set it appropriately
            to: {
                group_id: this.#id,
                message_type: message_type_id,
            },
            payload,
        };
        this.agent.send_msg(msg);
        return msg;
    }

    add_message_handler(message_type, fn) {
        let message_type_id = message_type;
        if (!isUuid(message_type)) {
            message_type_id = get_uuid_for(message_type, this.#namespace); 
        }

        this.message_types.set(message_type, {
            name: message_type,
            id: message_type_id,
            fn: fn
        });

        this.on(message_type_id, fn);
        // Updates to message handlers are not automatic, you must call update_group_membership
        return message_type_id;
    }

    remove_message_handler(message_type) {
        let message_type_id = message_type;
        if (!isUuid(message_type)) {
            message_type_id = get_uuid_for(message_type, this.#namespace); 
        }
        this.message_types.delete(message_type);
        this.off(message_type_id);
    }

    // update_group_membership() 
    // Sync's the current group/message type setup to the node via join_group
    update_group_membership() {
        let message_type_ids = [];
        this.message_types.forEach( (msg_type_object, key) => {
            message_type_ids.push(msg_type_object.id);
        })
        const msg = this.agent.createControlMessage("join_group", { group: this.#id, message_types: message_type_ids });
        this.agent.send_msg(msg);
    }

    leave() {
        const msg = this.agent.createControlMessage("leave_group", { group: this.#id });
        this.agent.send_msg(msg);
    }

    route_group_message(msg) {
        this.emit(msg.to.message_type, {
            group: this,
            message_type: msg.to.message_type,
            message: msg
        });
    }

    join_complete(msg) {
        this.emit('membership_updated', {
            group: this,
            message_type: msg.to.message_type,
            message: msg
        });
    }

    leave_complete(msg) {
        this.message_types.clear();
        this.emit('group_left', {
            group: this,
            message_type: msg.to.message_type,
            message: msg
        });
    }

}

function debug_print_msg(msg) {
    console.log("Msg ID: ", msg.msg_id);
    console.log("Type: ", msg.type);
    if (msg.type == 'control') {
        console.log("Payload", msg.payload);
    }   
}

/** PanAgent main class */
export default class PanAgent {
    constructor(opts = {}) {
        attachDispatcher(this);
        if (!opts.url) throw new Error("PanAgent requires url");
        if (!opts.app_id) throw new Error("PanAgent requires app_id");

        this.url = opts.url;
        this.app_id = opts.app_id;
        this.namespace = opts.namespace || this.app_id;
        this.encoding = PAN_ENCODING_JSON;

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
        this.groups = new Map(); // groupId -> PanGroup
        this.pendingJoins = new Map(); // groupId -> {resolve,reject,timeout}
        this.pendingLeaves = new Map();

        this._shouldRun = true;
    }

    setup_websocket() {
        this.ws.on("message", (data) => {
            try {
                const msg = decodePacket(data);
                this.stats.bytes_in += data.length;
                this.stats.msgs_in_total++;
                const t = msg.type || "unknown";
                this.stats.msgs_in_by_type[t] =
                    (this.stats.msgs_in_by_type[t] || 0) + 1;
                // console.log("INBOUND MSG:", msg);
                this.handle_inbound_message(msg);
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

    /** Connect and perform HELO */
    async connect() {
        if (this.state !== "DISCONNECTED") throw new Error("connect() invalid state");
        this.state = "CONNECTING";


        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 8000);
            this.ws = new WebSocket(this.url);
            this.ws.binaryType = "arraybuffer";
            this.ws.once("open", () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.once("error", reject);
        });

        this.setup_websocket();

        // Send helo
        const msg = this.createControlMessage('helo', {});
        this.send_msg(msg, 1);

    }

    /** Authenticate after helo */
    authenticate({ token, tokens }) {
        if (this.state !== "CONNECTED_UNTRUSTED") throw new Error("Not ready to authenticate");

        const msg = this.createControlMessage("auth", { token, tokens });
        this.send_msg(msg);
        this.state = "AUTHENTICATING";
    }

    handle_auth_result(auth_reply) {
        if (auth_reply.payload.msg_type === "auth.failed") {
            this.emit("auth_failed", auth_reply);
            this.state = "CONNECTED_UNTRUSTED";
        } else if (auth_reply.payload.msg_type === 'auth.ok') {
            this.node_id = auth_reply.payload.node_id; 
            this.conn_id = auth_reply.payload.conn_id;

            this.state = "AUTHENTICATED";
            this.stats.authenticated_at = nowMs();
            this.emit("auth_success", auth_reply);
        }
    }

    /** Join group */
    join_group(group_name, message_types = {}) {
        if (this.state !== "AUTHENTICATED") throw new Error("join_group requires authenticated");

        let group_id = group_name;
        // if gId is not a uuid already, map it to one using our namespace
        if (!isUuid(group_id)) {
            group_id = get_uuid_for(group_name, this.namespace);
        }

        // reuse our existing group if we have one, otherwise create one
        let group = this.groups.get(group_id);
        
        if (!group) {
            group = new PanGroup({
                agent: this, 
                name: group_name,
                id: group_id,
                namespace: this.namespace
            });
            this.groups.set(group_id, group);
        }

        let message_type_ids = []
        for (const [key, fn] of Object.entries(message_types)) {
            message_type_ids.push(group.add_message_handler(key, fn));
        }
        group.update_group_membership();
        
        return group;
    }

    handle_join_group_reply(msg) {
        try {
            const group_id = msg.payload?.group;
            const group = this.groups.get(group_id);
            group.join_complete(msg);
        } catch(e) {
            console.error('Group Join failure for group_id: ', group_id, e);
        }
    }

    handle_leave_group_reply(msg) {
        const group_id = msg.payload?.group;
        const group = this.groups.get(group_id);
        group.leave_complete(msg);
        this.groups.delete(group_id);
    }


    /** Direct and group sends */
    send_direct(to, msgType, payload, opts = {}) {
        if (this.state !== "AUTHENTICATED") throw new Error("Not authenticated");
        const msg = {
            type: "direct",
            ttl: opts.ttl ?? this.default_ttl,
            to,
            payload,
        };
        this.send_msg(msg);
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

    handle_inbound_message(msg) {
        let decoded_payload;
        switch (msg.type) {
            case 'control':  
                decoded_payload = JSON.parse(new TextDecoder().decode(msg.payload));
                msg.payload = decoded_payload;
                this.dispatch_control_message(msg);
                break;

            case 'direct':   
                this.emit("direct_message", msg);
                break;

            case 'broadcast': 
                const group = this.groups.get(msg.to.group_id);
                if (group) { 
                    group.route_group_message(msg);
                }
                this.emit("group_message", msg);
                break;

            default: 
                console.error('unknown message type received: ' + msg.type, err);
                // we return because we do not want to emit message_received on a bad packet
                return;
                break;
        }
        //debug_print_msg(msg);
        this.emit("message_received", msg);
    }

    dispatch_control_message(msg) {
        const control_message_type = msg.payload.msg_type;
        this.emit("control", msg);

        switch (control_message_type) {
            case "helo": 
                this.emit("helo", msg);
                this.state = "CONNECTED_UNTRUSTED";
                this.stats.connected_at = nowMs();
                break;

            case "auth.ok":
            case "auth.failed": 
                this.handle_auth_result(msg);
                break;

            case "join_group_reply": 
                this.handle_join_group_reply(msg);
                break;

            case "leave_group_reply": 
                this.handle_leave_group_reply(msg);
                break;

            case "error": 
                console.warn('protocol error:', msg);
                this.emit("error", msg);
                break;

            default: 
                console.warn('Unknown control message type: ' + control_message_type, msg)
                break;
        }
        return msg;
    }

    send_msg(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            throw new Error("WebSocket not open");

        let pkt = {
            ...msg,
            from: {
                node_id: this.node_id,
                conn_id: this.conn_id,
            },
            version: this.encoding,
        };
        if (pkt.type == 'control') {
            pkt.ttl = 1;
        } else if (typeof msg.ttl == 'undefined') {
            pkt.ttl = this.default_ttl
        } else {
            pkt.ttl = Math.min(msg.ttl, this.max_ttl);
        }
        if (pkt.type == 'broadcast' && typeof pkt.spread != 'number') {
            pkt.spread = pkt.ttl;
        }
           
        if (!pkt.msg_id) pkt.msg_id = crypto.randomUUID();
        //console.log('cccc', pkt);

        const raw = encodePacket(pkt);
        
        this.stats.bytes_out += Buffer.byteLength(raw);
        this.stats.msgs_out_total++;
        const t = msg.type || "unknown";
        this.stats.msgs_out_by_type[t] = (this.stats.msgs_out_by_type[t] || 0) + 1;

        this.ws.send(raw);
    }




    _log(...a) {
        if (this.debug) console.log("[PanAgent]", ...a);
    }


    /** Stats getter (deep copy) */
    get_stats() {
        return JSON.parse(JSON.stringify(this.stats));
    }

    createControlMessage(msg_type, payload, msg_id) {
        let new_msg = { 
            payload: { 
                ...payload,
                msg_type: msg_type
            },  
            to: {
                node_id: this.node_id,
                conn_id: NULL_ID
            },
            type: "control",
            msg_id: msg_id || crypto.randomUUID()
        };  
        return new_msg;
    }
}
