const { loadPanAgent } = require('./pan-agent.cjs');

(async () => {
const { PanAgent } = await loadPanAgent();
const client = new PanAgent({
    url: 'ws://localhost:5295', 
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbGllbnRfbmFtZSI6ImJvYiIsImlhdCI6MTc0NDA4ODYxNywiZXhwIjoxNzc1NjI0NjE3LCJhdWQiOiJwYW4tbmV0d29yayJ9.P0YbRvbnF-1GvjBPjrMfg2YauUKFC3MuBCrupF4c8Cw',
    appId: 'b28ce075-5bf3-4803-bb50-ae96701c1469'
});


  await client.connect();
  console.log('Connected via CommonJS!');
})();
