import { PanAgent } from '../pan-agent.mjs';
import assert from 'assert';
import { uuidv4 } from '../uuid.mjs';
import jwt from 'jsonwebtoken';

const DEFAULT_NODE_URL = 'ws://localhost:5295';
const NODE_URL = process.env.PAN_SERVER_URL || DEFAULT_NODE_URL;

const CONNECT_TOKEN_SECRET = process.env.PAN_SERVER_TOKEN_SECRET || 'supersecret';
const APP_ID = uuidv4(); // Random namespace for test


describe('PanAgent Client Behavior (external node)', function() {
    let agent;

    before(async function() {
        const GENERATED_TOKEN = jwt.sign({
            identifier: "agent-test"
        }, CONNECT_TOKEN_SECRET, { 
            expiresIn: 300
        });

        agent = new PanAgent({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        await agent.connect();
    });

    after(async function() {
        if (agent?.socket?.readyState === WebSocket.OPEN) {
            agent.socket.close();
        }
    });

    it('should send and receive a direct message to itself', function(done) {
        this.timeout(1000);

        const payload = { hello: 'first-message' };
        const testType = 'test.direct.first';

        agent.on('direct', (msg) => {
            if (msg.msg_type === testType) {
                assert.strictEqual(msg.type, 'direct');
                assert.deepStrictEqual(msg.payload, payload);
                done();
            }
        });

        agent.sendDirect(agent.nodeId, agent.connId, testType, payload);
    });

    it('should reconnect and send/receive another direct message', function(done) {
        this.timeout(3000);

        const payload = { hello: 'second-message' };
        const testType = 'test.direct.second';

        agent.once('disconnected', async () => {
            try {
                await agent.reconnect();

                agent.on('direct', (msg) => {
                    if (msg.msg_type === testType) {
                        assert.strictEqual(msg.type, 'direct');
                        assert.deepStrictEqual(msg.payload, payload);
                        done();
                    }
                });

                agent.sendDirect(agent.nodeId, agent.connId, testType, payload);
            } catch (err) {
                done(err);
            }
        });
        agent.disconnect();

    });

    it('should fail authentication with an invalid token', function(done) {
        this.timeout(3000);

        const BAD_TOKEN = jwt.sign({
            identifier: "bad-agent"
        }, 'wrong-secret', { expiresIn: 300 }); // SIGNED WITH WRONG SECRET

        const badAgent = new PanAgent({
            url: NODE_URL,
            token: BAD_TOKEN,
            appId: APP_ID
        });

        badAgent.connect()
          .then(() => {
              badAgent.disconnect();
              done(new Error('Should not have connected with bad token'));
          })
          .catch((err) => {
              badAgent.disconnect();
              assert.ok(err, 'Expected connection failure');
              done();
          });
    });

    it('should fail authentication with a token missing identifier', function(done) {
        this.timeout(3000);

        const BAD_TOKEN = jwt.sign({
            foo: "bar" // Missing "identifier"
        }, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

        const badAgent = new PanAgent({
            url: NODE_URL,
            token: BAD_TOKEN,
            appId: APP_ID
        });

        badAgent.connect()
          .then(() => {
              badAgent.disconnect();
              done(new Error('Should not have connected with missing identifier'));
          })
          .catch((err) => {
              badAgent.disconnect();
              assert.ok(err, 'Expected connection failure');
              done();
          });
    });

    it('agents should receive only the messages for types they subscribed to', function(done) {
        this.timeout(5000);

        const GENERATED_TOKEN = jwt.sign({
            identifier: "agent-test-subscribe"
        }, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

        const agentA = new PanAgent({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        const agentB = new PanAgent({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        Promise.all([agentA.connect(), agentB.connect()])
          .then(async () => {
              const groupName = "testgroup-" + uuidv4();
              const groupId = agentA.getGroupId(groupName);

              let agentA_received = false;
              let agentB_received = false;

              const groupA = await agentA.joinGroup(groupId, {
                  "typeA": (msg) => {
                      agentA_received = true;
                  }
              });

              const groupB = await agentB.joinGroup(groupId, {
                  "typeB": (msg) => {
                      agentB_received = true;
                  }
              });

              groupB.send("typeA", { data: "B -> A" });
              groupA.send("typeB", { data: "A -> B" });

              setTimeout(() => {
                  agentA.disconnect();
                  agentB.disconnect();
                  try {
                      assert.strictEqual(agentA_received, true, 'AgentA did not receive expected message');
                      assert.strictEqual(agentB_received, true, 'AgentB did not receive expected message');
                      done();
                  } catch (err) {
                      done(err);
                  }
              }, 1000);
          })
          .catch(done);
    });
    
    it('agents should NOT receive messages for types they did not subscribe to', function(done) {
	this.timeout(3000);

	const GENERATED_TOKEN = jwt.sign({
	    identifier: "agent-test-filter"
	}, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

	const agentA = new PanAgent({
	    url: NODE_URL,
	    token: GENERATED_TOKEN,
	    appId: APP_ID
	});

	const agentB = new PanAgent({
	    url: NODE_URL,
	    token: GENERATED_TOKEN,
	    appId: APP_ID
	});

	Promise.all([agentA.connect(), agentB.connect()])
	  .then(async () => {
	      const groupName = "testgroup-" + uuidv4();
	      const groupId = agentA.getGroupId(groupName);

	      const groupA = await agentA.joinGroup(groupId, {
		  "allowedA": (msg) => {}
	      });

	      const groupB = await agentB.joinGroup(groupId, {
		  "allowedB": (msg) => {}
	      });

	      // Attach raw 'broadcast' listeners to catch unexpected message types
	      agentA.on('broadcast', (msg) => {
		  if (msg.msg_type !== 'allowedA') {
		      done(new Error(`AgentA received unexpected message type: ${msg.msg_type}`));
		  }
	      });

	      agentB.on('broadcast', (msg) => {
		  if (msg.msg_type !== 'allowedB') {
		      done(new Error(`AgentB received unexpected message type: ${msg.msg_type}`));
		  }
	      });

              groupA.send("unsubscribedTypeB", { data: "should not see" });
              groupB.send("unsubscribedTypeA", { data: "should not see" });

	      setTimeout(() => {
                  agentA.disconnect();
                  agentB.disconnect();
		  done(); // if nothing unexpected happened, we're good
	      }, 1000);
	  })
	  .catch(done);
    });



});
