#!/usr/bin/env node
/**
 * pan-chat.mjs
 *
 * Minimal interactive PAN chat tester using the new PanAgent interface.
 *
 * Flow:
 *  1) connect()  -> receive helo
 *  2) decide trust (app-side)
 *  3) authenticate() using Vouchsafe token
 *  4) join_group()
 *  5) interactive chat
 *
 * Commands:
 *   /status <msg>
 *   /quit
 */

import fs from "node:fs";
import readline from "node:readline";
import process from "node:process";

import PanAgent from "./pan-agent.js";
import {
    Identity,
    validateVouchToken,
    getAppClaims
} from "vouchsafe";

/* ------------------------------------------------------------ */
/* Argument parsing                                             */
/* ------------------------------------------------------------ */

function parseArgs(argv) {
    const args = {
        url: null,
        identityPath: null,
        group: null,
        appId: "da19daa2-1c45-4257-9690-947598760c0e",
        namespace: null,
        ttl: null,
        reconnectConnId: null,
    };

    const positional = [];

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];

        if (a === "--app-id") {
            args.appId = argv[++i];
            continue;
        }
        if (a === "--namespace") {
            args.namespace = argv[++i];
            continue;
        }
        if (a === "--ttl") {
            const v = Number(argv[++i]);
            args.ttl = Number.isFinite(v) ? v : null;
            continue;
        }
        if (a === "--reconnect") {
            args.reconnectConnId = argv[++i];
            continue;
        }
        if (a === "--nick") {
            args.nickname = argv[++i];
            continue;
        }

        positional.push(a);
    }

    args.url = positional[0] || null;
    args.identityPath = positional[1] || null;
    args.group = positional[2] || null;

    return args;
}

/* ------------------------------------------------------------ */
/* Helpers                                                      */
/* ------------------------------------------------------------ */

function shortId(str, len = 8) {
    if (!str || typeof str !== "string") return "?";
    return str.length <= len ? str : str.slice(0, len);
}

function formatFrom(msg) {
    const f = msg?.from || {};
    return `${shortId(f.node_id, 6)}/${shortId(f.conn_id, 6)}`;
}

/* ------------------------------------------------------------ */
/* Trust decision                                               */
/* ------------------------------------------------------------ */

async function decideTrust(heloMsg) {
    const payload = heloMsg.payload || {};
    const serverUrn = payload.i_am;
    const heloToken = payload.helo_token;

    const allow = (process.env.PAN_TRUST_URNS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

    if (allow.length > 0 && !allow.includes(serverUrn)) {
        console.error(`[trust] server URN not allowlisted: ${serverUrn}`);
        return false;
    }

    if (heloToken) {
        try {
            const decoded = await validateVouchToken(heloToken);
            const appClaims = getAppClaims(decoded);

            if (appClaims?.purpose && appClaims.purpose !== "agent-helo") {
                console.error(`[trust] unexpected helo purpose: ${appClaims.purpose}`);
                return false;
            }
        } catch (e) {
            console.error(`[trust] invalid helo token: ${e.message}`);
            return false;
        }
    }

    return true;
}

/* ------------------------------------------------------------ */
/* Auth token minting                                           */
/* ------------------------------------------------------------ */

async function mintAuthToken(identity, reconnectConnId) {
    const exp = Math.floor(Date.now() / 1000) + 60;

    const claims = {
        purpose: "agent-connect",
        exp,
    };

    if (reconnectConnId) {
        claims.reconnect = reconnectConnId;
    }

    return identity.attest(claims);
}

/* ------------------------------------------------------------ */
/* Main                                                         */
/* ------------------------------------------------------------ */

async function main() {
    const args = parseArgs(process.argv);

    if (!args.url || !args.identityPath || !args.group) {
        console.error(
            "Usage: node pan-chat.mjs <ws_url> <identity.json> <group> " +
            "[--app-id PANChat] [--namespace uuid] [--ttl n] [--reconnect conn_id]"
        );
        process.exit(2);
    }

    const idData = JSON.parse(fs.readFileSync(args.identityPath, "utf8"));
    const identity = await Identity.from(idData);
    let group;
    //console.log(identity);
    let nick = identity.urn.split(/[:\.]/)[2]
    let myName = args.nickname || nick;
    let myStatus = 'online'; 
    const peerStatus = new Map();

    const agent = new PanAgent({
        url: args.url,
        app_id: args.appId,
        namespace: args.namespace || args.appId,
        default_ttl: args.ttl ?? 8,
        max_ttl: 32,
        debug: false,
    });

    agent.on("connected", () => {
        console.log(`[net] connected to ${args.url}`);
    });

    agent.on("disconnected", (info) => {
        console.log(`[net] disconnected code=${info.code} reason=${info.reason}`);
        process.exit(1);
    });

    agent.on("error", (err) => {
        console.error(`[net] error: ${err.payload.message}`);
    });

    /* ---------------- HELO ---------------- */

    await agent.connect();

    let { data } = await agent.waitFor('helo');
    
    console.log(`[net] got Helo`);
    // decide trust:
    console.log(`[helo] server=${data.payload.i_am || "(missing)"}`);
    console.log(`[helo] token=${data.payload.helo_token ? "present" : "missing"}`);

    const trusted = await decideTrust(data);
    if (!trusted) {
        console.log("[trust] rejected; disconnecting");
        agent.close(1000, "untrusted server");
        process.exit(1);
    }

    console.log("[trust] accepted");
    
    // trigger authentication
    const authToken = await mintAuthToken(identity, args.reconnectConnId);
    const authInfo = agent.authenticate({ token: authToken });

    const authResult = await agent.waitFor(['auth_success', 'auth_failed'], { timeout: 6000 });

    if (authResult.event == 'auth_failed') {
        console.log('Authorization failed: ', msg.payload.message);
        agent.close(1000, "Authorization failed");
        process.exit(1);
    } else if (authResult.event == 'auth_success') {
        // authentication succeeded.
        console.log(
            `[auth] ok node=${shortId(authResult.data.payload.node_id)} ` +
            `conn=${shortId(authResult.data.payload.conn_id)}`
        );
        console.log(`[auth] agent=${identity.urn}`);
        // trigger group join
        group = agent.join_group(args.group, {
            chat: (event) => {
                const payload = JSON.parse(new TextDecoder().decode(event.message.payload));
                const text = payload?.text ?? String(payload ?? "");
                const peer_id = event.message.from.node_id + ":" + event.message.from.conn_id;  
                const peer_status = peerStatus.get(peer_id);
                let name;
                if (peer_status) {
                    name = peer_status.name;
                } else {
                    name = formatFrom(event.message);
                }
                console.log(`${name}: ${text}`);
            },
            status: (event) => {
                const payload = JSON.parse(new TextDecoder().decode(event.message.payload));
                const text = payload?.text ?? String(payload ?? "");
                const peer_id = event.message.from.node_id + ":" + event.message.from.conn_id;  
                const old_peer_status = peerStatus.get(peer_id);
                // only show if we get a new status.
                if (!old_peer_status || old_peer_status.name != payload.name || old_peer_status.text != payload.text) {
                    peerStatus.set(peer_id, { name: payload.name, text: text });
                    console.log(`${payload.name} status -> ${text}`);
                }
            },
        });

        console.log(`[group] joining ${args.group}`);
        let joinResult = await group.waitFor('membership_updated', { 
            match: (evt) => {
                return group.get_id() == evt.data.message.payload.group;
            } 
        });

        group.send("status", { name: myName, text: myStatus });
        setInterval(() => {
            group.send("status", { name: myName, text: myStatus });
        }, 5000);
        console.log("[status] set online");
    }
    /* ---------------- INTERACTIVE LOOP ---------------- */

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    let quitting = false;

    async function gracefulQuit() {
        if (quitting) return;
        quitting = true;

        try {
            myStatus = "offline";
            await group.send("status", { name: myName, text: myStatus });
            console.log("[status] set offline");
        } catch {}

        agent.close(1000, "quit");
        rl.close();
        process.exit(0);
    }

    process.on("SIGINT", gracefulQuit);
    process.on("SIGTERM", gracefulQuit);

    console.log("Type a message. Commands: /status <msg>, /quit");

    rl.on("line", async (line) => {
        const s = line.trim();
        if (!s) return;

        if (s === "/quit") {
            await gracefulQuit();
            return;
        }

        if (s.startsWith("/status")) {
            const text = s.slice(7).trim() || "online";
            myStatus = text;
            await group.send("status", { name: myName, text: myStatus });
            console.log(`[status] set ${text}`);
            return;
        }
        if (s.startsWith("/nick")) {
            const text = s.slice(5).trim() || "online";
            myName = text;
            await group.send("status", { name: myName, text: myStatus });
            console.log(`[status] set ${text}`);
            return;
        }

        await group.send("chat", { text: s });
    });
}

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
