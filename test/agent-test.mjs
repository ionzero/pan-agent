import { PanActor } from '../pan-actor.mjs';
import assert from 'assert';
import { uuidv4 } from '../uuid.mjs';
import jwt from 'jsonwebtoken';

const DEFAULT_NODE_URL = 'ws://localhost:5295';
const NODE_URL = process.env.PAN_SERVER_URL || DEFAULT_NODE_URL;

const CONNECT_TOKEN_SECRET = process.env.PAN_SERVER_TOKEN_SECRET || 'supersecret';
const APP_ID = uuidv4(); // Random namespace for test


describe('PanActor Client Behavior (external node)', function() {
    let actor;

    before(async function() {
        const GENERATED_TOKEN = jwt.sign({
            identifier: "actor-test"
        }, CONNECT_TOKEN_SECRET, { 
            expiresIn: 300
        });

        actor = new PanActor({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        await actor.connect();
    });

    after(async function() {
        if (actor?.socket?.readyState === WebSocket.OPEN) {
            actor.socket.close();
        }
    });

    it('should send and receive a direct message to itself', function(done) {
        this.timeout(1000);

        const payload = { hello: 'first-message' };
        const testType = 'test.direct.first';

        actor.on('direct', (msg) => {
            if (msg.msg_type === testType) {
                assert.strictEqual(msg.type, 'direct');
                assert.deepStrictEqual(msg.payload, payload);
                done();
            }
        });

        actor.sendDirect(actor.nodeId, actor.connId, testType, payload);
    });

    it('should reconnect and send/receive another direct message', function(done) {
        this.timeout(3000);

        const payload = { hello: 'second-message' };
        const testType = 'test.direct.second';

        actor.once('disconnected', async () => {
            try {
                await actor.reconnect();

                actor.on('direct', (msg) => {
                    if (msg.msg_type === testType) {
                        assert.strictEqual(msg.type, 'direct');
                        assert.deepStrictEqual(msg.payload, payload);
                        done();
                    }
                });

                actor.sendDirect(actor.nodeId, actor.connId, testType, payload);
            } catch (err) {
                done(err);
            }
        });
        actor.disconnect();

    });

    it('should fail authentication with an invalid token', function(done) {
        this.timeout(3000);

        const BAD_TOKEN = jwt.sign({
            identifier: "bad-actor"
        }, 'wrong-secret', { expiresIn: 300 }); // SIGNED WITH WRONG SECRET

        const badActor = new PanActor({
            url: NODE_URL,
            token: BAD_TOKEN,
            appId: APP_ID
        });

        badActor.connect()
          .then(() => {
              badActor.disconnect();
              done(new Error('Should not have connected with bad token'));
          })
          .catch((err) => {
              badActor.disconnect();
              assert.ok(err, 'Expected connection failure');
              done();
          });
    });

    it('should fail authentication with a token missing identifier', function(done) {
        this.timeout(3000);

        const BAD_TOKEN = jwt.sign({
            foo: "bar" // Missing "identifier"
        }, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

        const badActor = new PanActor({
            url: NODE_URL,
            token: BAD_TOKEN,
            appId: APP_ID
        });

        badActor.connect()
          .then(() => {
              badActor.disconnect();
              done(new Error('Should not have connected with missing identifier'));
          })
          .catch((err) => {
              badActor.disconnect();
              assert.ok(err, 'Expected connection failure');
              done();
          });
    });

    it('actors should receive only the messages for types they subscribed to', function(done) {
        this.timeout(5000);

        const GENERATED_TOKEN = jwt.sign({
            identifier: "actor-test-subscribe"
        }, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

        const actorA = new PanActor({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        const actorB = new PanActor({
            url: NODE_URL,
            token: GENERATED_TOKEN,
            appId: APP_ID
        });

        Promise.all([actorA.connect(), actorB.connect()])
          .then(async () => {
              const groupName = "testgroup-" + uuidv4();
              const groupId = actorA.getGroupId(groupName);

              let actorA_received = false;
              let actorB_received = false;

              const groupA = await actorA.joinGroup(groupId, {
                  "typeA": (msg) => {
                      actorA_received = true;
                  }
              });

              const groupB = await actorB.joinGroup(groupId, {
                  "typeB": (msg) => {
                      actorB_received = true;
                  }
              });

              groupB.send("typeA", { data: "B -> A" });
              groupA.send("typeB", { data: "A -> B" });

              setTimeout(() => {
                  actorA.disconnect();
                  actorB.disconnect();
                  try {
                      assert.strictEqual(actorA_received, true, 'ActorA did not receive expected message');
                      assert.strictEqual(actorB_received, true, 'ActorB did not receive expected message');
                      done();
                  } catch (err) {
                      done(err);
                  }
              }, 1000);
          })
          .catch(done);
    });
    
    it('actors should NOT receive messages for types they did not subscribe to', function(done) {
	this.timeout(3000);

	const GENERATED_TOKEN = jwt.sign({
	    identifier: "actor-test-filter"
	}, CONNECT_TOKEN_SECRET, { expiresIn: 300 });

	const actorA = new PanActor({
	    url: NODE_URL,
	    token: GENERATED_TOKEN,
	    appId: APP_ID
	});

	const actorB = new PanActor({
	    url: NODE_URL,
	    token: GENERATED_TOKEN,
	    appId: APP_ID
	});

	Promise.all([actorA.connect(), actorB.connect()])
	  .then(async () => {
	      const groupName = "testgroup-" + uuidv4();
	      const groupId = actorA.getGroupId(groupName);

	      const groupA = await actorA.joinGroup(groupId, {
		  "allowedA": (msg) => {}
	      });

	      const groupB = await actorB.joinGroup(groupId, {
		  "allowedB": (msg) => {}
	      });

	      // Attach raw 'broadcast' listeners to catch unexpected message types
	      actorA.on('broadcast', (msg) => {
		  if (msg.msg_type !== 'allowedA') {
		      done(new Error(`ActorA received unexpected message type: ${msg.msg_type}`));
		  }
	      });

	      actorB.on('broadcast', (msg) => {
		  if (msg.msg_type !== 'allowedB') {
		      done(new Error(`ActorB received unexpected message type: ${msg.msg_type}`));
		  }
	      });

              groupA.send("unsubscribedTypeB", { data: "should not see" });
              groupB.send("unsubscribedTypeA", { data: "should not see" });

	      setTimeout(() => {
                  actorA.disconnect();
                  actorB.disconnect();
		  done(); // if nothing unexpected happened, we're good
	      }, 1000);
	  })
	  .catch(done);
    });



});
